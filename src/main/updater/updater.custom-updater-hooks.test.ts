import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { TestRunner, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { CustomUpdaterHost, CustomUpdaterPort } from './custom/custom-updater-types'
import type * as UpdaterModule from './updater-service'
import type { UpdateStatus } from '../../shared/updater/update-status-types'
import { updaterMainWindow } from './testing/updater-test-main-window'

// Why: v1.4.262 deleted the shared updater test harness and module loader; the fork's updater tests are their only
// remaining consumers, so both live inline here and in updater.custom-build.test.ts rather than in new files.
const {
  appMock,
  autoUpdaterMock,
  armExitWatchdogMock,
  recordUpdaterLifecycleMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const { afterAll, vi } = await import('vitest')

  type UpdaterSpy = Mock<(...args: unknown[]) => unknown>
  type LinuxPackageType = 'deb' | 'rpm' | 'non-root' | 'unusable'

  type AutoUpdaterMock = {
    autoDownload: boolean
    autoInstallOnAppQuit: boolean
    autoRunAppAfterInstall: boolean
    allowPrerelease: boolean
    allowDowngrade: boolean
    disableDifferentialDownload: boolean
    logger: { error: (message: unknown) => void } | undefined
    on: Mock<(event: string, handler: (...args: unknown[]) => void) => AutoUpdaterMock>
    checkForUpdates: UpdaterSpy
    downloadUpdate: UpdaterSpy
    quitAndInstall: UpdaterSpy
    setFeedURL: UpdaterSpy
    updateConfigPath: string | undefined
    emit: (event: string, ...args: unknown[]) => void
    reset: () => void
  }

  type AppMock = {
    isPackaged: boolean
    getVersion: Mock<() => string>
    on: Mock<(event: string, handler: (...args: unknown[]) => void) => AppMock>
    prependListener: Mock<(event: string, handler: (...args: unknown[]) => void) => AppMock>
    emit: (event: string, ...args: unknown[]) => void
    quit: UpdaterSpy
  }

  type UpdaterModuleFactories = {
    electron: () => {
      app: AppMock
      BrowserWindow: { getAllWindows: Mock<() => unknown[]> }
      autoUpdater: { on: UpdaterSpy }
      powerMonitor: { on: UpdaterSpy }
      shell: { showItemInFolder: UpdaterSpy }
      net: { fetch: UpdaterSpy }
    }
    electronUpdater: () => { autoUpdater: AutoUpdaterMock }
    electronUpdaterLoader: () => { loadElectronAutoUpdater: () => AutoUpdaterMock }
    ptyKillAll: () => { killAllPty: UpdaterSpy }
    linuxUpdatePackageType: () => {
      getLinuxPackageType: Mock<() => LinuxPackageType>
      getLinuxRootPackageType: Mock<() => 'deb' | 'rpm' | null>
      isExternallyManagedLinuxInstall: Mock<() => boolean>
    }
    updaterLifecycleDiagnostics: () => { recordUpdaterLifecycle: UpdaterSpy }
    updaterChangelog: () => { fetchChangelog: UpdaterSpy }
    updaterNudge: () => { fetchNudge: UpdaterSpy; shouldApplyNudge: UpdaterSpy }
    updateInstallExitWatchdog: () => {
      armUpdateInstallExitWatchdog: UpdaterSpy
      disarmUpdateInstallExitWatchdog: UpdaterSpy
    }
    updaterPrereleaseFeed: () => {
      fetchNewerReleaseTagsWithReadiness: (...args: unknown[]) => Promise<unknown>
      fetchLatestStableReleaseTag: () => Promise<string | null>
      getReleaseDownloadUrl: (tag: string) => string
    }
    localBuildSwitch: () => { chooseLocalBuild: UpdaterSpy }
    localBuildFeedServer: () => { startLocalBuildFeed: UpdaterSpy }
  }

  type UpdaterMocks = {
    appMock: AppMock
    browserWindowMock: { getAllWindows: Mock<() => unknown[]> }
    nativeUpdaterMock: { on: UpdaterSpy }
    autoUpdaterMock: AutoUpdaterMock
    killAllPtyMock: UpdaterSpy
    powerMonitorOnMock: UpdaterSpy
    getLinuxPackageTypeMock: Mock<() => LinuxPackageType>
    getLinuxRootPackageTypeMock: Mock<() => 'deb' | 'rpm' | null>
    isExternallyManagedLinuxInstallMock: Mock<() => boolean>
    recordUpdaterLifecycleMock: UpdaterSpy
    fetchChangelogMock: UpdaterSpy
    fetchNudgeMock: UpdaterSpy
    shouldApplyNudgeMock: UpdaterSpy
    armExitWatchdogMock: UpdaterSpy
    disarmExitWatchdogMock: UpdaterSpy
    fetchNewerReleaseTagsMock: UpdaterSpy
    fetchLatestStableReleaseTagMock: Mock<() => Promise<string | null>>
    chooseLocalBuildMock: UpdaterSpy
    startLocalBuildFeedMock: UpdaterSpy
    closeLocalBuildFeedMock: UpdaterSpy
    moduleFactories: UpdaterModuleFactories
    resetUpdaterMocks: () => void
  }

  // resetModules leaves real timers armed; track global timer APIs, excluding timers/promises and promisify.
  type RealTimerHandle = ReturnType<typeof setTimeout> | number
  type ArmTimer = (...args: never[]) => RealTimerHandle
  type ClearTimer = (handle?: RealTimerHandle) => void

  type TimerGlobals = {
    setTimeout: ArmTimer
    setInterval: ArmTimer
    clearTimeout: ClearTimer
    clearInterval: ClearTimer
  }

  // DOM and Node timer overloads disagree; preserve their handles while tracking both shapes.
  const timerGlobals = globalThis as unknown as TimerGlobals

  const armedTimeouts = new Set<RealTimerHandle>()
  const armedIntervals = new Set<RealTimerHandle>()
  let originalTimers: TimerGlobals | null = null
  let trackingTimers: TimerGlobals | null = null

  const trackArmed = (arm: ArmTimer, armed: Set<RealTimerHandle>): ArmTimer =>
    Object.assign((...args: never[]) => {
      const handle = arm(...args)
      armed.add(handle)
      return handle
    }, arm)

  // Untrack cancelled handles so recycled numeric ids cannot cancel unrelated timers.
  const trackCleared = (clear: ClearTimer, armed: Set<RealTimerHandle>): ClearTimer =>
    Object.assign((handle?: RealTimerHandle) => {
      if (handle !== undefined) {
        armed.delete(handle)
      }
      clear(handle)
    }, clear)

  const trackRealTimers = (): void => {
    // Fake-clock restoration would discard our wrapper.
    if (trackingTimers || vi.isFakeTimers()) {
      return
    }
    const original: TimerGlobals = {
      setTimeout: timerGlobals.setTimeout,
      setInterval: timerGlobals.setInterval,
      clearTimeout: timerGlobals.clearTimeout,
      clearInterval: timerGlobals.clearInterval
    }
    originalTimers = original
    trackingTimers = {
      setTimeout: trackArmed(original.setTimeout, armedTimeouts),
      setInterval: trackArmed(original.setInterval, armedIntervals),
      clearTimeout: trackCleared(original.clearTimeout, armedTimeouts),
      clearInterval: trackCleared(original.clearInterval, armedIntervals)
    }
    Object.assign(timerGlobals, trackingTimers)
  }

  const clearTrackedRealTimers = (): void => {
    const original = originalTimers
    const tracking = trackingTimers
    if (!original || !tracking) {
      return
    }
    try {
      for (const handle of armedTimeouts) {
        original.clearTimeout(handle)
      }
      for (const handle of armedIntervals) {
        original.clearInterval(handle)
      }
    } finally {
      armedTimeouts.clear()
      armedIntervals.clear()
      // Restore only globals we still own; a fake clock may be installed over the wrapper.
      if (timerGlobals.setTimeout === tracking.setTimeout) {
        Object.assign(timerGlobals, original)
        originalTimers = null
        trackingTimers = null
      }
    }
  }

  /** Call from an awaited vi.hoisted block so module factories see initialized mocks. */
  const createUpdaterMocks = (): UpdaterMocks => {
    const appEvents = new EventEmitter()
    const updaterEvents = new EventEmitter()
    const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEvents.on(event, handler)
      return appMock
    })
    const appPrependListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEvents.prependListener(event, handler)
      return appMock
    })
    const appEmit = (event: string, ...args: unknown[]): void => {
      appEvents.emit(event, ...args)
    }
    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      updaterEvents.on(event, handler)
      return autoUpdaterMock
    })
    const emit = (event: string, ...args: unknown[]): void => {
      updaterEvents.emit(event, ...args)
    }

    // resetModules cannot cancel old timers; fence stale module instances from shared spies.
    let currentGeneration = 0

    const loadGenerationScopedAutoUpdater = (): AutoUpdaterMock => {
      const loadedGeneration = currentGeneration
      return new Proxy(autoUpdaterMock, {
        get(target, property) {
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: raw string|symbol pass-through; the receiver stays the target on purpose.
          const value = Reflect.get(target, property)
          if (loadedGeneration === currentGeneration || typeof value !== 'function') {
            return value
          }
          return () => undefined
        },
        set(target, property, value) {
          return loadedGeneration === currentGeneration ? Reflect.set(target, property, value) : true
        }
      })
    }

    const reset = () => {
      currentGeneration += 1
      appEvents.removeAllListeners()
      appOn.mockClear()
      appPrependListener.mockClear()
      updaterEvents.removeAllListeners()
      on.mockClear()
      autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
      autoUpdaterMock.downloadUpdate.mockReset()
      autoUpdaterMock.quitAndInstall.mockReset()
      autoUpdaterMock.setFeedURL.mockClear()
      autoUpdaterMock.updateConfigPath = undefined
      autoUpdaterMock.allowPrerelease = false
      autoUpdaterMock.allowDowngrade = false
      autoUpdaterMock.disableDifferentialDownload = false
      autoUpdaterMock.autoRunAppAfterInstall = true
      autoUpdaterMock.logger = undefined
      delete (autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature
    }

    const autoUpdaterMock: AutoUpdaterMock = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
      disableDifferentialDownload: false,
      logger: undefined as { error: (message: unknown) => void } | undefined,
      on,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn(),
      updateConfigPath: undefined as string | undefined,
      emit,
      reset
    }

    const appMock: AppMock = {
      isPackaged: true,
      getVersion: vi.fn(() => '1.0.51'),
      on: appOn,
      prependListener: appPrependListener,
      emit: appEmit,
      quit: vi.fn()
    }
    const browserWindowMock = {
      getAllWindows: vi.fn(() => [])
    }
    const nativeUpdaterMock = {
      on: vi.fn()
    }
    const killAllPtyMock = vi.fn()
    const powerMonitorOnMock = vi.fn()
    const getLinuxRootPackageTypeMock = vi.fn<() => 'deb' | 'rpm' | null>(() => null)
    const getLinuxPackageTypeMock = vi.fn<() => LinuxPackageType>(() => {
      return getLinuxRootPackageTypeMock() ?? 'non-root'
    })
    const isExternallyManagedLinuxInstallMock = vi.fn<() => boolean>(() => false)
    const recordUpdaterLifecycleMock = vi.fn()
    const fetchChangelogMock = vi.fn()
    const fetchNudgeMock = vi.fn()
    const shouldApplyNudgeMock = vi.fn()
    const armExitWatchdogMock = vi.fn()
    const disarmExitWatchdogMock = vi.fn()
    const fetchNewerReleaseTagsMock = vi.fn()
    const fetchLatestStableReleaseTagMock = vi.fn<() => Promise<string | null>>()
    const chooseLocalBuildMock = vi.fn()
    const startLocalBuildFeedMock = vi.fn()
    const closeLocalBuildFeedMock = vi.fn()

    const moduleFactories: UpdaterModuleFactories = {
      electron: () => ({
        app: appMock,
        BrowserWindow: browserWindowMock,
        autoUpdater: nativeUpdaterMock,
        powerMonitor: { on: powerMonitorOnMock },
        shell: { showItemInFolder: vi.fn() },
        net: { fetch: vi.fn() }
      }),
      electronUpdater: () => ({ autoUpdater: autoUpdaterMock }),
      electronUpdaterLoader: () => ({ loadElectronAutoUpdater: loadGenerationScopedAutoUpdater }),
      ptyKillAll: () => ({ killAllPty: killAllPtyMock }),
      // Keep real artifact capture/redaction under test; fake only package-type detection.
      linuxUpdatePackageType: () => ({
        getLinuxPackageType: getLinuxPackageTypeMock,
        getLinuxRootPackageType: getLinuxRootPackageTypeMock,
        isExternallyManagedLinuxInstall: isExternallyManagedLinuxInstallMock
      }),
      updaterLifecycleDiagnostics: () => ({ recordUpdaterLifecycle: recordUpdaterLifecycleMock }),
      updaterChangelog: () => ({ fetchChangelog: fetchChangelogMock }),
      updaterNudge: () => ({ fetchNudge: fetchNudgeMock, shouldApplyNudge: shouldApplyNudgeMock }),
      updateInstallExitWatchdog: () => ({
        armUpdateInstallExitWatchdog: armExitWatchdogMock,
        disarmUpdateInstallExitWatchdog: disarmExitWatchdogMock
      }),
      updaterPrereleaseFeed: () => ({
        fetchLatestStableReleaseTag: fetchLatestStableReleaseTagMock,
        fetchNewerReleaseTagsWithReadiness: async (...args: unknown[]) => {
          const result = await fetchNewerReleaseTagsMock(...args)
          return Array.isArray(result)
            ? { tags: result, state: result.length > 0 ? 'ready' : 'no-newer' }
            : result
        },
        getReleaseDownloadUrl: (tag: string) =>
          `https://github.com/stablyai/orca/releases/download/${tag}`
      }),
      localBuildSwitch: () => ({ chooseLocalBuild: chooseLocalBuildMock }),
      localBuildFeedServer: () => ({ startLocalBuildFeed: startLocalBuildFeedMock })
    }

    const resetUpdaterMocks = () => {
      vi.clearAllTimers()
      vi.useRealTimers()
      // The generation fence ignores stale calls but does not cancel their timers.
      clearTrackedRealTimers()
      vi.resetModules()
      autoUpdaterMock.reset()
      nativeUpdaterMock.on.mockReset()
      browserWindowMock.getAllWindows.mockReset()
      browserWindowMock.getAllWindows.mockReturnValue([])
      appMock.getVersion.mockReset()
      appMock.getVersion.mockReturnValue('1.0.51')
      appMock.quit.mockReset()
      appMock.isPackaged = true
      killAllPtyMock.mockReset()
      armExitWatchdogMock.mockReset()
      disarmExitWatchdogMock.mockReset()
      powerMonitorOnMock.mockReset()
      getLinuxRootPackageTypeMock.mockReset().mockReturnValue(null)
      getLinuxPackageTypeMock.mockReset().mockImplementation(() => {
        return getLinuxRootPackageTypeMock() ?? 'non-root'
      })
      isExternallyManagedLinuxInstallMock.mockReset().mockReturnValue(false)
      recordUpdaterLifecycleMock.mockReset()
      fetchNudgeMock.mockReset().mockResolvedValue(null)
      shouldApplyNudgeMock.mockReset().mockReturnValue(false)
      fetchChangelogMock.mockReset().mockResolvedValue(null)
      fetchNewerReleaseTagsMock.mockReset().mockResolvedValue([])
      fetchLatestStableReleaseTagMock.mockReset().mockResolvedValue('v1.0.51')
      chooseLocalBuildMock.mockReset()
      closeLocalBuildFeedMock.mockReset()
      startLocalBuildFeedMock.mockReset().mockResolvedValue({
        url: 'http://127.0.0.1:1234/token/',
        close: closeLocalBuildFeedMock
      })
      vi.unstubAllGlobals()
      trackRealTimers()
    }

    // Drop fake timers before restoring real globals, or the wrapper's identity guard cannot restore them.
    afterAll(() => {
      vi.useRealTimers()
      clearTrackedRealTimers()
    })

    return {
      appMock,
      browserWindowMock,
      nativeUpdaterMock,
      autoUpdaterMock,
      killAllPtyMock,
      powerMonitorOnMock,
      getLinuxPackageTypeMock,
      getLinuxRootPackageTypeMock,
      isExternallyManagedLinuxInstallMock,
      recordUpdaterLifecycleMock,
      fetchChangelogMock,
      fetchNudgeMock,
      shouldApplyNudgeMock,
      armExitWatchdogMock,
      disarmExitWatchdogMock,
      fetchNewerReleaseTagsMock,
      fetchLatestStableReleaseTagMock,
      chooseLocalBuildMock,
      startLocalBuildFeedMock,
      closeLocalBuildFeedMock,
      moduleFactories,
      resetUpdaterMocks
    }
  }

  return createUpdaterMocks()
})

// What the updater service's own subclass builds when nobody injects a module: the production default.
const { productionDefault } = vi.hoisted(() => ({
  productionDefault: { current: null as unknown }
}))
vi.mock('./custom/custom-updater-defaults', () => ({
  createDefaultCustomUpdater: () => productionDefault.current
}))

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('../ipc/pty/provider/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-package/linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./releases/updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./nudges/nudge-campaign', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./releases/updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('./releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))
vi.mock('../local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('../local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
vi.mock('../startup/shell-environment/hydrate-shell-path', () => ({
  runWithLaunchPath: (action: () => unknown): unknown => action()
}))

warmUpdaterModule()

type FakeModule = { [Key in keyof CustomUpdaterPort]: ReturnType<typeof vi.fn> } & CustomUpdaterPort

/** A stand-in for the fork updater: every entry answers "not mine" until a test says otherwise. */
function fakeCustomUpdater(handled = false): FakeModule {
  return {
    start: vi.fn(() => true),
    checkFromMenu: vi.fn(() => handled),
    checkInBackground: vi.fn(() => handled),
    download: vi.fn(() => handled),
    quitAndInstall: vi.fn(() => handled),
    invokeNativeInstall: vi.fn(() => handled)
  }
}

describe('updater hooks for the self-updater patch', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  async function setup(
    version: string,
    customUpdater: CustomUpdaterPort | null,
    installMode?: 'interactive' | 'unsupported-headless-serve'
  ) {
    appMock.getVersion.mockReturnValue(version)
    vi.useFakeTimers()
    const send = vi.fn()
    await loadUpdaterModule()
    const { CustomUpdaterSetup } = await import('./custom/custom-updater-setup')
    const updater = new CustomUpdaterSetup(() => customUpdater)
    updater.setupAutoUpdater(updaterMainWindow(send), {
      getLastUpdateCheckAt: () => null,
      ...(installMode ? { installMode } : {})
    })
    await vi.advanceTimersByTimeAsync(0)
    return { send, updater }
  }

  function statuses(send: ReturnType<typeof vi.fn>): UpdateStatus[] {
    return send.mock.calls.filter(([channel]) => channel === 'updater:status').map(([, s]) => s)
  }

  function startedHost(fake: FakeModule): CustomUpdaterHost {
    const [host] = fake.start.mock.calls[0]
    return host
  }

  describe('on a custom build', () => {
    const VERSION = '1.4.258+custom.4'

    it('starts the module once per setup with a host bound to the real lifecycle', async () => {
      const fake = fakeCustomUpdater()
      const { send } = await setup(VERSION, fake)

      expect(fake.start).toHaveBeenCalledOnce()
      const host = startedHost(fake)
      expect(host.getCurrentStatus()).toEqual({ state: 'idle' })
      expect(host.isInstalling()).toBe(false)
      expect(host.shouldDeferMacQuitForInstall()).toBe(true)

      host.sendStatus({ state: 'checking', userInitiated: true })

      expect(host.getCurrentStatus()).toEqual({ state: 'checking', userInitiated: true })
      expect(statuses(send)).toEqual([{ state: 'checking', userInitiated: true }])
    })

    it('is what the updater service itself builds, so the production path reaches the module', async () => {
      const fake = fakeCustomUpdater(true)
      productionDefault.current = fake
      appMock.getVersion.mockReturnValue(VERSION)
      vi.useFakeTimers()
      const service = await loadUpdaterModule()

      service.setupAutoUpdater(updaterMainWindow(vi.fn()), { getLastUpdateCheckAt: () => null })
      service.checkForUpdatesFromMenu({ channel: 'rc' })
      service.checkForUpdates()
      service.downloadUpdate()
      service.quitAndInstall()
      await vi.advanceTimersByTimeAsync(0)

      expect(fake.start).toHaveBeenCalledOnce()
      expect(fake.checkFromMenu).toHaveBeenCalledWith({ channel: 'rc' })
      expect(fake.checkInBackground).toHaveBeenCalledOnce()
      expect(fake.download).toHaveBeenCalledOnce()
      expect(fake.quitAndInstall).toHaveBeenCalledOnce()
    })

    it('keeps electron-updater out of the way: no feed, no schedule, no native calls', async () => {
      const fake = fakeCustomUpdater()
      await setup(VERSION, fake)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)

      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    })

    it('hands the menu, background, download and restart requests to the module first', async () => {
      const fake = fakeCustomUpdater(true)
      const { send, updater } = await setup(VERSION, fake)

      updater.checkForUpdatesFromMenu({ channel: 'rc' })
      updater.checkForUpdates()
      updater.downloadUpdate()
      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(1000)

      expect(fake.checkFromMenu).toHaveBeenCalledWith({ channel: 'rc' })
      expect(fake.checkInBackground).toHaveBeenCalledOnce()
      expect(fake.download).toHaveBeenCalledOnce()
      expect(fake.quitAndInstall).toHaveBeenCalledOnce()
      // Upstream's own answer ("up to date") must not appear when the module handled the request.
      expect(statuses(send)).toEqual([])
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    })

    it('falls back to the unchanged upstream behavior when the module declines', async () => {
      const fake = fakeCustomUpdater(false)
      const { send, updater } = await setup(VERSION, fake)

      updater.checkForUpdatesFromMenu({ localBuild: true })
      await vi.advanceTimersByTimeAsync(0)

      expect(fake.checkFromMenu).toHaveBeenCalledWith({ localBuild: true })
      expect(statuses(send).at(-1)).toEqual({ state: 'not-available', userInitiated: true })
    })

    it('swaps through the module instead of electron-updater when upstream runs the install', async () => {
      const fake = fakeCustomUpdater(false)
      fake.invokeNativeInstall.mockReturnValue(true)
      await setup(VERSION, fake)
      const host = startedHost(fake)

      // The module's restart timer calls this host entry once an update is staged.
      void host.performQuitAndInstall()
      await vi.advanceTimersByTimeAsync(2000)

      expect(fake.invokeNativeInstall).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(host.isInstalling()).toBe(true)
    })

    it('never loads electron-updater for the swap: with nothing staged the install fails cleanly', async () => {
      const fake = fakeCustomUpdater(false)
      const { send } = await setup(VERSION, fake)
      const host = startedHost(fake)

      void host.performQuitAndInstall()
      await vi.advanceTimersByTimeAsync(2000)

      expect(fake.invokeNativeInstall).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      // Upstream's install catch reports the failure and leaves the app running.
      expect(host.isInstalling()).toBe(false)
      expect(statuses(send).at(-1)).toMatchObject({ state: 'error' })
    })

    it('never reaches upstream restart handling on a custom build: the module answers or nothing happens', async () => {
      const fake = fakeCustomUpdater(false)
      const { updater } = await setup(VERSION, fake)

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(2000)

      expect(fake.quitAndInstall).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    })

    it('stays fully off when the factory returns null', async () => {
      const { send, updater } = await setup(VERSION, null)

      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)

      expect(statuses(send)).toEqual([{ state: 'not-available', userInitiated: true }])
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    })

    it('does not start for a headless serve process', async () => {
      const fake = fakeCustomUpdater()
      await setup(VERSION, fake, 'unsupported-headless-serve')

      expect(fake.start).not.toHaveBeenCalled()
    })
  })

  describe('on macOS, with upstream preflight and commit in the loop', () => {
    const originalPlatform = process.platform

    beforeEach(() => {
      setPlatform('darwin')
    })
    afterEach(() => {
      setPlatform(originalPlatform)
    })

    it('runs the preflight, swaps through the module, commits and arms the exit watchdog', async () => {
      const fake = fakeCustomUpdater(false)
      fake.invokeNativeInstall.mockReturnValue(true)
      const { send } = await setup('1.4.258+custom.4', fake)
      const host = startedHost(fake)
      // What the module's native update-downloaded listener does once Squirrel has staged the zip.
      const mac = await import('./mac-install/updater-mac-install')
      mac.handleMacInstallerReady(false, vi.fn(), vi.fn())
      host.sendStatus({ state: 'downloaded', version: '1.4.258+custom.5' })

      void host.performQuitAndInstall()
      await vi.advanceTimersByTimeAsync(2000)

      const events = recordUpdaterLifecycleMock.mock.calls.map(([event]) => event)
      expect(events).toEqual(
        expect.arrayContaining(['quit_and_install_started', 'quit_and_install_invoking_native'])
      )
      expect(events).not.toContain('macos_install_blocked_by_running_instances')
      expect(events).not.toContain('quit_and_install_failed')
      expect(statuses(send)).toContainEqual({
        state: 'downloaded',
        version: '1.4.258+custom.5',
        installing: true
      })
      expect(fake.invokeNativeInstall).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(armExitWatchdogMock).toHaveBeenCalledOnce()
    })
  })

  describe('on builds that are not custom builds', () => {
    it.each(['1.4.258', '1.4.258-rc.1'])(
      'never starts or consults the module for %s',
      async (version) => {
        const fake = fakeCustomUpdater(true)
        const { updater } = await setup(version, fake)

        updater.checkForUpdatesFromMenu()
        updater.checkForUpdates()
        updater.downloadUpdate()
        updater.quitAndInstall()
        await vi.advanceTimersByTimeAsync(2000)

        expect(fake.start).not.toHaveBeenCalled()
        for (const entry of [
          fake.checkFromMenu,
          fake.checkInBackground,
          fake.download,
          fake.quitAndInstall,
          fake.invokeNativeInstall
        ]) {
          expect(entry).not.toHaveBeenCalled()
        }
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalled()
        expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce()
      }
    )
  })
})

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

// Warm the module graph under hookTimeout so initial transforms do not consume testTimeout.
function warmUpdaterModule(): void {
  beforeAll(async () => {
    await import('./updater-service')
  })
}

// Vitest cannot cancel timed-out imports; reject late continuations before they touch the next test.
async function loadUpdaterModule(): Promise<typeof UpdaterModule> {
  const owner = TestRunner.getCurrentTest()
  const module = await import('./updater-service')
  if (owner !== undefined && TestRunner.getCurrentTest() !== owner) {
    // The timed-out test's rejection is already settled, so report the late import separately.
    process.emitWarning(
      `updater import requested by "${owner.name}" resolved after that test ended. The test timed ` +
        `out mid-import; fix that timeout, not the assertions.`
    )
    throw new Error(`updater import for "${owner.name}" resolved after that test ended`)
  }
  return module
}

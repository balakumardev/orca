import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater-service'
import type { CustomUpdaterHost, CustomUpdaterPort } from './custom/custom-updater-types'
import type { UpdateStatus } from '../../shared/updater/update-status-types'
import type { BrowserWindow } from 'electron'

// The updater reaches its window only through isDestroyed and webContents.isDestroyed/send.
function updaterMainWindow(send: (channel: string, ...args: unknown[]) => void): BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for the main window the updater talks to.
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send }
  } as unknown as BrowserWindow
}

const {
  appMock,
  autoUpdaterMock,
  nativeUpdaterMock,
  armExitWatchdogMock,
  recordUpdaterLifecycleMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => createUpdaterMocks())

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
vi.mock('./mac-install/macos-shipit-scheduling', () => ({ configureMacShipItScheduling: vi.fn() }))
vi.mock('./mac-install/shipit-leftover-recovery', () => ({
  prepareThisProcessShipItStaging: () => null
}))
vi.mock('./mac-install/macos-update-running-instances', () => ({
  getMacUpdateRunningInstances: async () => []
}))
vi.mock('./lifecycle/serve-supervisor-install-park', () => ({
  parkServeSupervisorsForInstall: async () => ({ kind: 'parked' }),
  commitServeSupervisorPark: async () => {},
  releaseServeSupervisorPark: async () => {}
}))
vi.mock('../window/renderer-relays/native-unload-coordinator', () => ({
  prepareRendererForUpdate: vi.fn(async () => () => {})
}))
vi.mock('./lifecycle/updater-installer-session-release', () => ({
  releaseSessionsForInstaller: () => 0
}))
vi.mock('../cli/appimage/appimage-copy-pre-extraction', () => ({
  preExtractDownloadedAppImageUpdate: async () => false
}))

function warmUpdaterModule(): void {
  beforeAll(async () => {
    await import('./updater-service')
  })
}

async function loadUpdaterModule(): Promise<typeof UpdaterModule> {
  return import('./updater-service')
}

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
      // What the module does at start: register upstream's mac listeners on Electron's native updater.
      const mac = await import('./mac-install/updater-mac-install')
      mac.registerMacUpdaterEvents(host)
      host.sendStatus({ state: 'downloading', percent: 100, version: '1.4.258+custom.5' })
      // Squirrel fires its own update-downloaded once the staged zip is on disk: that marks it ready.
      const nativeDownloaded = nativeUpdaterMock.on.mock.calls.findLast(
        ([event]) => event === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloaded).toBeDefined()
      nativeDownloaded?.()
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

// vi.hoisted runs before static imports are initialized, so load EventEmitter on demand.
async function createUpdaterMocks() {
  const { EventEmitter } = await import('node:events')
  const appEvents = new EventEmitter()
  const updaterEvents = new EventEmitter()

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
    disableDifferentialDownload: false,
    logger: undefined as { error: (message: unknown) => void } | undefined,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      updaterEvents.on(event, handler)
      return autoUpdaterMock
    }),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    updateConfigPath: undefined as string | undefined,
    emit: (event: string, ...args: unknown[]): void => {
      updaterEvents.emit(event, ...args)
    },
    reset: () => {
      appEvents.removeAllListeners()
      updaterEvents.removeAllListeners()
      autoUpdaterMock.on.mockClear()
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
  }

  const appMock = {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEvents.on(event, handler)
      return appMock
    }),
    prependListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEvents.prependListener(event, handler)
      return appMock
    }),
    emit: (event: string, ...args: unknown[]): void => {
      appEvents.emit(event, ...args)
    },
    quit: vi.fn()
  }

  const browserWindowMock = { getAllWindows: vi.fn(() => []) }
  const nativeUpdaterMock = { on: vi.fn() }
  const killAllPtyMock = vi.fn()
  const powerMonitorOnMock = vi.fn()
  const getLinuxRootPackageTypeMock = vi.fn<() => 'deb' | 'rpm' | null>(() => null)
  const getLinuxPackageTypeMock = vi.fn<() => 'deb' | 'rpm' | 'non-root' | 'unusable'>(() => {
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

  const moduleFactories = {
    electron: () => ({
      app: appMock,
      BrowserWindow: browserWindowMock,
      autoUpdater: nativeUpdaterMock,
      powerMonitor: { on: powerMonitorOnMock },
      shell: { showItemInFolder: vi.fn() },
      net: { fetch: vi.fn() }
    }),
    electronUpdater: () => ({ autoUpdater: autoUpdaterMock }),
    electronUpdaterLoader: () => ({ loadElectronAutoUpdater: () => autoUpdaterMock }),
    ptyKillAll: () => ({ killAllPty: killAllPtyMock }),
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
  }

  return {
    appMock,
    autoUpdaterMock,
    nativeUpdaterMock,
    armExitWatchdogMock,
    recordUpdaterLifecycleMock,
    moduleFactories,
    resetUpdaterMocks
  }
}

import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater-service'
import { updaterMainWindow } from './testing/updater-test-main-window'
import type { UpdateStatus } from '../../shared/updater/update-status-types'

const {
  appMock,
  autoUpdaterMock,
  fetchNudgeMock,
  fetchNewerReleaseTagsMock,
  powerMonitorOnMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => createUpdaterMocks())

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

describe('updater with a custom build version', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  async function startUpdater(
    version: string
  ): Promise<{ send: ReturnType<typeof vi.fn>; updater: typeof UpdaterModule }> {
    appMock.getVersion.mockReturnValue(version)
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(updaterMainWindow(send), { getLastUpdateCheckAt: () => null })
    await vi.advanceTimersByTimeAsync(0)
    return { send, updater }
  }

  function lastStatus(send: ReturnType<typeof vi.fn>): UpdateStatus | undefined {
    return send.mock.calls.findLast(([channel]) => channel === 'updater:status')?.[1]
  }

  it('reports up to date without touching the release feed', async () => {
    const { send, updater } = await startUpdater('1.0.51+custom.3')

    updater.checkForUpdatesFromMenu()
    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)

    expect(lastStatus(send)).toEqual({ state: 'not-available', userInitiated: true })
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(fetchNudgeMock).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it('still checks the release feed for an official version', async () => {
    const { send, updater } = await startUpdater('1.0.51')

    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)

    expect(lastStatus(send)).toMatchObject({ state: 'available', version: '1.0.61' })
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalled()
    expect(fetchNudgeMock).toHaveBeenCalled()
    expect(powerMonitorOnMock).toHaveBeenCalled()
  })
})

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
    fetchNudgeMock,
    fetchNewerReleaseTagsMock,
    powerMonitorOnMock,
    armExitWatchdogMock,
    recordUpdaterLifecycleMock,
    moduleFactories,
    resetUpdaterMocks
  }
}

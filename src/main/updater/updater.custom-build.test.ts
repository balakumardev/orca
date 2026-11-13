import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater-service'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'
import type { UpdateStatus } from '../../shared/update-status-types'

const {
  appMock,
  autoUpdaterMock,
  fetchNudgeMock,
  fetchNewerReleaseTagsMock,
  powerMonitorOnMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () =>
  (await import('./testing/updater-test-harness')).createUpdaterMocks()
)

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('../ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
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

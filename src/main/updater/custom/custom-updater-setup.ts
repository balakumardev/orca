import type { BrowserWindow } from 'electron'
import type { UpdateCheckOptions } from '../../../shared/update-status-types'
import { isAutoUpdateDisabledForBuild } from '../lifecycle/updater-state'
import { UpdaterSetup, type UpdaterSetupOptions } from '../lifecycle/updater-setup'
import { isMacInstallRequested } from '../mac-install/updater-mac-install'
import { createDefaultCustomUpdater } from './custom-updater-defaults'
import type { CustomUpdaterPort } from './custom-updater-types'

/**
 * Upstream's updater with the fork's self-updater in front of it (patch self-updater). On a `+custom.` build
 * upstream's own updater is off, so the fork's module answers the check, download and restart requests; every
 * other build, and every request the module declines, runs upstream's code unchanged. Living in a subclass keeps
 * upstream's `updater-setup.ts` untouched: the only upstream seam is `invokeNativeQuitAndInstall`.
 */
export class CustomUpdaterSetup extends UpdaterSetup {
  private customUpdater: CustomUpdaterPort | null | undefined

  /** `createCustomUpdater` returns null to keep a custom build's updater fully off; tests pass a fake. */
  constructor(
    private readonly createCustomUpdater: () => CustomUpdaterPort | null = createDefaultCustomUpdater
  ) {
    super()
  }

  override setupAutoUpdater(mainWindow: BrowserWindow | null, opts?: UpdaterSetupOptions): void {
    super.setupAutoUpdater(mainWindow, opts)
    this.startCustomUpdater()
  }

  override checkForUpdates(): void {
    if (this.customUpdater?.checkInBackground()) {
      return
    }
    super.checkForUpdates()
  }

  override checkForUpdatesFromMenu(options?: UpdateCheckOptions): void {
    if (this.customUpdater?.checkFromMenu(options)) {
      return
    }
    super.checkForUpdatesFromMenu(options)
  }

  override downloadUpdate(): void {
    if (this.customUpdater?.download()) {
      return
    }
    super.downloadUpdate()
  }

  override quitAndInstall(): void {
    if (this.customUpdater?.quitAndInstall()) {
      return
    }
    super.quitAndInstall()
  }

  // A staged fork update swaps through Electron's native Squirrel. electron-updater is never loaded on a custom
  // build: with nothing staged this throws, and upstream's install catch restores the app and reports it.
  protected override invokeNativeQuitAndInstall(supervisorOwnsRelaunch: boolean): void {
    if (!isAutoUpdateDisabledForBuild()) {
      super.invokeNativeQuitAndInstall(supervisorOwnsRelaunch)
      return
    }
    if (!this.customUpdater?.invokeNativeInstall()) {
      throw new Error('There is no staged update to install')
    }
  }

  private startCustomUpdater(): void {
    if (this.updateInstallMode !== 'interactive' || !isAutoUpdateDisabledForBuild()) {
      return
    }
    this.customUpdater ??= this.createCustomUpdater()
    this.customUpdater?.start({
      getCurrentStatus: () => this.currentStatus,
      hasInstallableDownloadedVersion: () => this.hasInstallableDownloadedVersion(),
      getPendingInstallVersion: () => this.getPendingInstallVersion(),
      getKnownReleaseUrl: () => this.getKnownReleaseUrl(),
      performQuitAndInstall: () => this.performQuitAndInstall(),
      commitStagedMacInstall: () => this.commitStagedMacInstall(),
      failMacStaging: (error) => this.failMacStaging(error),
      shouldDeferMacQuitForInstall: () => this.updateInstallMode === 'interactive',
      sendStatus: (status) => this.sendStatus(status),
      isInstalling: () =>
        this.quitAndInstallInProgress ||
        this.pendingQuitAndInstallTimer !== null ||
        isMacInstallRequested(),
      handleQuitAndInstallFailure: (error) => this.handleQuitAndInstallFailure(error)
    })
  }
}

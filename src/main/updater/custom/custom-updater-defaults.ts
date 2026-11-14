import { app, autoUpdater, net } from 'electron'
import { QUIT_AND_INSTALL_DELAY_MS } from '../lifecycle/updater-state'
import {
  beginMacUpdateDownload,
  registerMacUpdaterEvents,
  setMacInstallPreflightInProgress
} from '../mac-install/updater-mac-install'
import { prepareThisProcessShipItStaging } from '../mac-install/shipit-leftover-recovery'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { downloadUpdateZip } from './custom-update-download'
import { CustomUpdateFeed } from './custom-update-feed'
import { isAllowedFeedUrl, resolveCustomUpdateFeedOrigin } from './custom-update-feed-origin'
import { createGuardedFetch } from './custom-update-guarded-fetch'
import { stageUpdateWithSquirrel } from './custom-update-squirrel-staging'
import { verifyUpdateBundle } from './custom-update-verifier'
import { CustomUpdater } from './custom-updater'

/** The production wiring: Electron's `net`, the native Squirrel updater, and upstream's mac install state. */
export function createDefaultCustomUpdater(): CustomUpdater {
  const env = process.env
  const origin = resolveCustomUpdateFeedOrigin(env, app.isPackaged)
  // net.request, not net.fetch: only it lets every redirect hop be checked before it is followed.
  const fetch = createGuardedFetch({
    request: (options) => net.request(options),
    isAllowedUrl: (url) => isAllowedFeedUrl(origin, url)
  })
  return new CustomUpdater({
    runtime: () => ({
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      userDataDir: app.getPath('userData')
    }),
    env,
    now: Date.now,
    random: Math.random,
    fetch,
    nativeUpdater: () => autoUpdater,
    prepareStaging: prepareThisProcessShipItStaging,
    createFeed: ({ running, origin }) =>
      new CustomUpdateFeed({ fetch, now: Date.now, origin, running }),
    download: downloadUpdateZip,
    verify: verifyUpdateBundle,
    stage: stageUpdateWithSquirrel,
    mac: {
      beginDownload: beginMacUpdateDownload,
      setPreflightInProgress: setMacInstallPreflightInProgress,
      registerEvents: registerMacUpdaterEvents,
      installDelayMs: QUIT_AND_INSTALL_DELAY_MS
    },
    log: (event, data) => recordUpdaterLifecycle(event, data)
  })
}

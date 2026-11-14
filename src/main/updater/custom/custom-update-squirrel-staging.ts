import { CustomUpdateError } from './custom-update-errors'
import { sha256OfFile } from './custom-update-download'
import { startSquirrelFeed, type SquirrelFeed } from './custom-update-squirrel-feed'

// Squirrel unzips, signature-checks and copies the whole app before it reports; upstream waits as long.
export const SQUIRREL_STAGING_TIMEOUT_MS = 180_000

/** Electron's native autoUpdater: Squirrel.Mac. */
export type NativeUpdaterPort = NodeJS.EventEmitter & {
  setFeedURL: (options: { url: string; headers?: Record<string, string> }) => void
  checkForUpdates: () => void
  quitAndInstall: () => void
}

export type StageUpdateRequest = {
  nativeUpdater: NativeUpdaterPort
  zipPath: string
  size: number
  expectedSha256: string
  /** Clears cancelled-ShipIt leftovers that would block staging (upstream #14732); null when not applicable. */
  prepareStaging: () => Promise<void> | null
  startFeed?: (request: { zipPath: string; size: number }) => Promise<SquirrelFeed>
  timeoutMs?: number
}

function waitForNativeStaging(
  nativeUpdater: NativeUpdaterPort,
  feed: SquirrelFeed,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: CustomUpdateError): void => {
      clearTimeout(timer)
      nativeUpdater.removeListener('update-downloaded', onDownloaded)
      nativeUpdater.removeListener('update-not-available', onNothing)
      nativeUpdater.removeListener('error', onError)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onDownloaded = (): void => settle()
    const onNothing = (): void =>
      settle(new CustomUpdateError('staging', 'macOS found no update to stage'))
    const onError = (error: Error): void =>
      settle(
        new CustomUpdateError('staging', `macOS refused the update: ${error.message}`, {
          cause: error
        })
      )
    const timer = setTimeout(
      () =>
        settle(
          new CustomUpdateError('staging-timeout', 'macOS did not finish preparing the update')
        ),
      timeoutMs
    )
    nativeUpdater.once('update-downloaded', onDownloaded)
    nativeUpdater.once('update-not-available', onNothing)
    nativeUpdater.once('error', onError)
    try {
      nativeUpdater.setFeedURL({ url: feed.url, headers: feed.headers })
      nativeUpdater.checkForUpdates()
    } catch (error) {
      settle(
        new CustomUpdateError('staging', 'macOS could not start staging the update', {
          cause: error
        })
      )
    }
  })
}

/**
 * Hands the verified zip to Squirrel.Mac through a one-shot loopback feed and resolves once macOS has staged it.
 * After that a plain quit installs it without relaunching, and `quitAndInstall` installs and relaunches
 * (Squirrel.Mac SQRLUpdater.m: prepareUpdateForInstallation / relaunchToInstallUpdate).
 */
export async function stageUpdateWithSquirrel(request: StageUpdateRequest): Promise<void> {
  // A changed file is named here; the feed then also hashes what it serves and withholds the end of a mismatch.
  if ((await sha256OfFile(request.zipPath)) !== request.expectedSha256) {
    // Verified a moment ago, so this says something about the disk or what runs on it, not about the release.
    throw new CustomUpdateError(
      'staging',
      'The downloaded update changed on disk before it was staged'
    )
  }
  const preparation = request.prepareStaging()
  if (preparation) {
    await preparation
  }
  const feed = await (request.startFeed ?? startSquirrelFeed)({
    zipPath: request.zipPath,
    size: request.size,
    sha256: request.expectedSha256
  })
  try {
    await waitForNativeStaging(
      request.nativeUpdater,
      feed,
      request.timeoutMs ?? SQUIRREL_STAGING_TIMEOUT_MS
    )
  } finally {
    await feed.close()
  }
}

import { join } from 'node:path'
import { toCustomUpdateError, type CustomUpdateFailureKind } from './custom-update-errors'
import type { CustomUpdateCandidate } from './custom-update-feed'
import { customUpdateChangelog } from './custom-update-statuses'
import { removeTree } from './custom-update-tree'
import type { CustomUpdaterDeps, CustomUpdaterHost } from './custom-updater-types'

type PipelineRequest = {
  candidate: CustomUpdateCandidate
  host: Pick<CustomUpdaterHost, 'sendStatus'>
  deps: Pick<
    CustomUpdaterDeps,
    | 'download'
    | 'verify'
    | 'stage'
    | 'fetch'
    | 'nativeUpdater'
    | 'prepareStaging'
    | 'runCommand'
    | 'getFreeBytes'
    | 'extraction'
    | 'mac'
    | 'log'
  >
  workDir: string
  /** Called when the checks have held, before staging: whatever the checks counted against the release ends there. */
  onVerified?: () => void
}

/**
 * A failure nobody classified takes the kind of the step it came from, and only a check that names itself a verdict
 * on the release's bytes is final (custom-update-verifier.ts): an error nobody expected says nothing about the release.
 */
async function inStep<T>(kind: CustomUpdateFailureKind, step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    throw toCustomUpdateError(error, kind)
  }
}

/**
 * Download, verify and stage one release. Resolves once macOS holds a staged copy; any failure rejects.
 * The working directory goes in every case (or is logged when it cannot): Squirrel keeps its own staged copy.
 */
export async function downloadVerifyAndStage({
  candidate,
  host,
  deps,
  workDir,
  onVerified
}: PipelineRequest): Promise<void> {
  const { manifest } = candidate
  const { version } = manifest
  deps.mac.beginDownload()
  host.sendStatus({ state: 'available', version, changelog: customUpdateChangelog(candidate) })
  host.sendStatus({ state: 'downloading', percent: 0, version })
  const zipPath = join(workDir, 'update.zip')
  try {
    await inStep('download', () =>
      deps.download({
        url: candidate.zipUrl,
        destination: zipPath,
        expectedSize: manifest.size,
        expectedSha256: manifest.sha256,
        fetch: deps.fetch,
        getFreeBytes: deps.getFreeBytes,
        onProgress: (percent) => host.sendStatus({ state: 'downloading', percent, version })
      })
    )
    host.sendStatus({ state: 'downloading', percent: 100, version })
    // A check that fails on the bundle's own bytes is final; anything else going wrong here is retried.
    const checks = await inStep('check-error', () =>
      deps.verify({
        zipPath,
        workDir,
        manifest,
        run: deps.runCommand,
        extraction: deps.extraction
      })
    )
    deps.log('custom_update_verified', { version, checks: checks.join(',') })
    onVerified?.()
    await inStep('staging', () =>
      deps.stage({
        nativeUpdater: deps.nativeUpdater(),
        zipPath,
        size: manifest.size,
        expectedSha256: manifest.sha256,
        prepareStaging: deps.prepareStaging
      })
    )
    deps.log('custom_update_staged', { version })
  } finally {
    // A tree that could not be removed stays on the disk, so it is logged; the next start sweeps it again.
    if (!(await removeTree(workDir))) {
      deps.log('custom_update_cleanup_failed', { directory: 'work' })
    }
  }
}

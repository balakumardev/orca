import type { ChangelogData, UpdateStatus } from '../../../shared/update-status-types'
import type { CustomUpdateCandidate } from './custom-update-feed'
import type { CustomUpdateError } from './custom-update-errors'

// Wording avoids the substrings the update card routes on (HTTP/2, Windows publisher checks).
const FAILURE_COPY: Record<CustomUpdateError['kind'], string> = {
  network: 'Could not reach GitHub to download the update.',
  'rate-limited': 'GitHub is limiting update checks right now. Try again later.',
  feed: 'Could not read the update information from GitHub.',
  download: 'The update download failed.',
  'disk-space': 'There is not enough free disk space to download the update.',
  verification: 'The downloaded update failed verification and was discarded.',
  staging: 'macOS could not prepare the update.',
  'staging-timeout':
    'macOS is taking long to prepare the update. If it finishes, the update installs the next time Orca quits.',
  'check-timeout': 'Checking the downloaded update took too long and was stopped.',
  'check-error': 'The downloaded update could not be verified. Orca will try again later.'
}

export function customUpdateChangelog(candidate: CustomUpdateCandidate): ChangelogData {
  const { version } = candidate.manifest
  return {
    release: {
      title: `Orca ${version}`,
      description: `Build ${version} from this fork's releases.`,
      releaseNotesUrl: candidate.releaseUrl
    },
    releasesBehind: null
  }
}

/** Decimal gigabytes, as macOS shows them, rounded up so the figure never understates what must be freed. */
function gigabytes(bytes: number): string {
  return (Math.ceil(bytes / 1e8) / 10).toFixed(1)
}

function failureMessage(failure: CustomUpdateError): string {
  const base = FAILURE_COPY[failure.kind]
  return failure.kind === 'disk-space' && failure.neededBytes !== null
    ? `${base} About ${gigabytes(failure.neededBytes)} GB of free space is needed.`
    : base
}

export function customUpdateFailureStatus(
  failure: CustomUpdateError,
  options: { version?: string; userInitiated: boolean }
): UpdateStatus {
  return {
    state: 'error',
    message: failureMessage(failure),
    retryable: failure.retryable,
    ...(options.version ? { version: options.version } : {}),
    ...(options.userInitiated ? { userInitiated: true } : {})
  }
}

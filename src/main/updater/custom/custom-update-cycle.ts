import { dirname, join } from 'node:path'
import { freeBytesOf } from './custom-update-disk'
import {
  CustomUpdateError,
  describeFailureForLog,
  toCustomUpdateError
} from './custom-update-errors'
import { diskNeededFor } from './custom-update-extract'
import type { CustomUpdateCandidate } from './custom-update-feed'
import { manifestTrustFailure } from './custom-update-manifest'
import { downloadVerifyAndStage } from './custom-update-pipeline'
import type { CustomUpdateState, StrikeStage } from './custom-update-state'
import type {
  CustomUpdateFeedPort,
  CustomUpdaterDeps,
  CustomUpdaterHost
} from './custom-updater-types'

// How many lower releases one check may try after the newest ones fail verification.
const MAX_FALLBACKS = 3
// Releases that were already set aside cost one small manifest read each, not a download; stop after this many.
const MAX_SKIPPED = 8
// A release that fails the same unclear way this many times within a day is set aside for a day (and until the app
// restarts, which forgets it sooner).
export const MAX_STRIKES = 3
// Failures that prove nothing alone, by the side of the update they came from: the checks after the download (a tool
// timing out or not running) and macOS refusing to stage it. They are counted, never written down.
const STRIKE_STAGES: Partial<Record<CustomUpdateError['kind'], StrikeStage>> = {
  'check-timeout': 'check',
  'check-error': 'check',
  staging: 'staging',
  'staging-timeout': 'staging'
}

export type CycleFailure = {
  outcome: 'failed'
  failure: CustomUpdateError
  candidate: CustomUpdateCandidate | null
  /** A download was under way, so the user already saw progress for it. */
  downloadShown: boolean
}
export type CycleResult =
  /** `heldBack`: a release was skipped only because failures here set it aside for now, so this is not "up to date". */
  | { outcome: 'none'; heldBack?: true }
  | { outcome: 'staged'; candidate: CustomUpdateCandidate }
  | CycleFailure

export type CycleRequest = {
  feed: CustomUpdateFeedPort
  host: Pick<CustomUpdaterHost, 'sendStatus'>
  deps: CustomUpdaterDeps
  /** What earlier checks learned: releases judged bad for good (kept across restarts) and strikes (kept in memory). */
  state: CustomUpdateState
  userInitiated: boolean
  updatesRoot: string
  /** Called right before a download starts. */
  onDownloadStart: () => Promise<void>
}

/** Disk space is read from the folder that holds the updates; it is created later, so its parent is asked. */
async function freeSpaceFor(request: CycleRequest): Promise<number> {
  try {
    return await (request.deps.getFreeBytes ?? freeBytesOf)(dirname(request.updatesRoot))
  } catch {
    // Not knowing the free space must not stop an update: the download and the extraction check it themselves.
    return Number.POSITIVE_INFINITY
  }
}

/**
 * One check: pick the newest eligible release, download, verify, stage. A release that fails a check that is a
 * verdict on its own bytes is set aside (for 30 days, across restarts, for manual checks too) and the next lower
 * eligible release is tried, so one bad newest release cannot hold back an older good one. Any other failure says
 * something about this machine at this moment: it is retried, and only three of one kind within a day set the release
 * aside, in memory, for a day (a person asking for a check is not held to that, and a restart forgets it).
 */
export async function runUpdateCycle(request: CycleRequest): Promise<CycleResult> {
  const { feed, host, deps, state } = request
  const tried = new Set<string>()
  let lastFailure: CycleFailure | null = null
  let skipped = 0
  let heldBack = false
  const nothing = (): CycleResult =>
    heldBack ? { outcome: 'none', heldBack: true } : { outcome: 'none' }
  for (let attempt = 0; attempt <= MAX_FALLBACKS;) {
    let candidate: CustomUpdateCandidate | null
    try {
      candidate = await feed.check({ exclude: new Set(tried), force: request.userInitiated })
    } catch (error) {
      return {
        outcome: 'failed',
        failure: toCustomUpdateError(error, 'network'),
        candidate: null,
        downloadShown: false
      }
    }
    if (!candidate) {
      return lastFailure ?? nothing()
    }
    const { version, sha256 } = candidate.manifest
    if (tried.has(version)) {
      // A feed that ignores the exclusion would loop here; stop rather than download the same release again.
      return lastFailure ?? nothing()
    }
    tried.add(version)
    const untrusted = manifestTrustFailure(candidate.manifest)
    if (untrusted || state.isRejected(version, sha256, !request.userInitiated)) {
      // No download and no fall-back used up. A manifest that claims an untrusted build is not remembered: it is
      // judged from the manifest alone, which costs nothing to read again, so a corrected one is picked up at once.
      skipped += 1
      heldBack ||= !untrusted && !state.isRejected(version, sha256, false)
      deps.log(
        untrusted ? 'custom_update_manifest_rejected' : 'custom_update_candidate_skipped',
        untrusted ? { version, reason: untrusted } : { version }
      )
      if (untrusted) {
        lastFailure = {
          outcome: 'failed',
          failure: new CustomUpdateError('verification', untrusted),
          candidate,
          downloadShown: false
        }
      }
      if (skipped > MAX_SKIPPED) {
        return lastFailure ?? nothing()
      }
      continue
    }
    attempt += 1
    // The same figure the download itself asks for, so there is no growth to wait for beyond it: the check passes
    // the moment the disk has what the update needs, and says what that is.
    const free = await freeSpaceFor(request)
    if (free < diskNeededFor(candidate.manifest.size)) {
      return {
        outcome: 'failed',
        failure: new CustomUpdateError(
          'disk-space',
          'There is not enough free disk space for the update',
          { freeBytes: free, neededBytes: diskNeededFor(candidate.manifest.size) }
        ),
        candidate,
        downloadShown: false
      }
    }
    await request.onDownloadStart()
    try {
      await downloadVerifyAndStage({
        candidate,
        host,
        deps,
        workDir: join(request.updatesRoot, `${version}-${deps.now()}`),
        onVerified: () => state.resetStrikes(version, sha256, 'check')
      })
      state.clear(version, sha256)
      return { outcome: 'staged', candidate }
    } catch (error) {
      const failure = toCustomUpdateError(error, 'download')
      lastFailure = { outcome: 'failed', failure, candidate, downloadShown: true }
      if (!failure.retryable) {
        state.reject(version, sha256, failure.kind)
      } else {
        const stage = STRIKE_STAGES[failure.kind]
        if (!stage || state.addStrike(version, sha256, stage) < MAX_STRIKES) {
          return lastFailure
        }
        state.setAsideForNow(version, sha256)
      }
      deps.log('custom_update_candidate_rejected', { version, ...describeFailureForLog(failure) })
    }
  }
  return lastFailure ?? nothing()
}

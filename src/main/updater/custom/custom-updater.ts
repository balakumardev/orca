import { join } from 'node:path'
import type { UpdateCheckOptions, UpdateStatus } from '../../../shared/update-status-types'
import { DownloadBackoff } from './custom-update-backoff'
import { runUpdateCycle, type CycleFailure, type CycleResult } from './custom-update-cycle'
import { describeFailureForLog } from './custom-update-errors'
import { resolveCustomUpdateFeedOrigin } from './custom-update-feed-origin'
import { CustomUpdateState, UPDATE_STATE_FILE_NAME } from './custom-update-state'
import { customUpdateFailureStatus } from './custom-update-statuses'
import { removeTree } from './custom-update-tree'
import { parseCustomBuildVersion } from './custom-update-version'
import type {
  CustomUpdateFeedPort,
  CustomUpdaterDeps,
  CustomUpdaterHost,
  CustomUpdaterPort
} from './custom-updater-types'

const INITIAL_CHECK_DELAY_MS = 90_000
export const CUSTOM_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000
const CHECK_JITTER_RATIO = 0.1
// Being offline says nothing about GitHub: look again soon instead of waiting out a whole interval (a download that
// keeps failing waits longer each time: custom-update-backoff.ts).
const OFFLINE_RETRY_MS = 15 * 60_000
const UPDATES_DIRECTORY = 'custom-updates'

type Phase = 'idle' | 'checking' | 'downloading' | 'staged' | 'installing'

/**
 * Updates a fork build from the fork's own GitHub releases. Upstream's updater stays off on these builds;
 * this feeds the same status events and install path (preflight, cleanup, native Squirrel swap).
 */
export class CustomUpdater implements CustomUpdaterPort {
  private host: CustomUpdaterHost | null = null
  private feed: CustomUpdateFeedPort | null = null
  private phase: Phase = 'idle'
  private cycle: Promise<void> | null = null
  private userInitiated = false
  private checkTimer: ReturnType<typeof setTimeout> | null = null
  private installTimer: ReturnType<typeof setTimeout> | null = null
  private stagedStatus: UpdateStatus | null = null
  private updatesRoot = ''
  private staleCleanup: Promise<void> = Promise.resolve()
  // Verdicts on releases are kept in the user data folder (a restart keeps them); strikes and set-asides live in memory.
  private state: CustomUpdateState | null = null
  private readonly backoff = new DownloadBackoff()
  // How long the next scheduled check waits after a failure that a sooner try may fix; null means the usual interval.
  private retryInMs: number | null = null

  constructor(private readonly deps: CustomUpdaterDeps) {}

  /**
   * True once this build can update itself; idempotent because setup reruns when the window is replaced.
   * A fault here must never stop the app from starting, so any throw leaves the updater off.
   */
  start(host: CustomUpdaterHost): boolean {
    if (this.host) {
      this.host = host
      return true
    }
    try {
      return this.startChecked(host)
    } catch (error) {
      this.host = null
      this.feed = null
      this.clearTimers()
      this.log('custom_update_start_failed', describeFailureForLog(error))
      return false
    }
  }

  private startChecked(host: CustomUpdaterHost): boolean {
    const runtime = this.deps.runtime()
    const running = parseCustomBuildVersion(runtime.version)
    if (!running || runtime.platform !== 'darwin' || runtime.arch !== 'arm64') {
      return false
    }
    const origin = resolveCustomUpdateFeedOrigin(this.deps.env, runtime.isPackaged)
    // A development run updates only against a loopback test feed.
    if (!runtime.isPackaged && !origin.overridden) {
      return false
    }
    this.feed = this.deps.createFeed({ running, origin })
    this.updatesRoot = join(runtime.userDataDir, UPDATES_DIRECTORY)
    this.state = new CustomUpdateState(
      join(runtime.userDataDir, UPDATE_STATE_FILE_NAME),
      this.deps.now,
      () => this.log('custom_update_state_write_failed', {})
    )
    this.state.load()
    this.deps.mac.registerEvents(host)
    this.deps.nativeUpdater().on('error', (error: Error) => this.handleNativeError(error))
    this.host = host
    // Nothing is in flight yet, so whatever an earlier run left behind is stale.
    // The sweep opens up directories an archive made unreadable first, so a hostile build cannot leave a tree behind.
    this.staleCleanup = removeTree(this.updatesRoot).then((removed) => {
      if (!removed) {
        this.log('custom_update_cleanup_failed', { directory: UPDATES_DIRECTORY })
      }
    })
    this.schedule(INITIAL_CHECK_DELAY_MS)
    return true
  }

  /** Returns true when this updater answered; false hands the request back to upstream's path. */
  checkFromMenu(options?: UpdateCheckOptions): boolean {
    if (!this.host) {
      return false
    }
    if (options?.localBuild || options?.targetTag) {
      return false
    }
    this.runCycle(true)
    return true
  }

  /** The download starts by itself; the card's retry button asks for another attempt. */
  download(): boolean {
    if (!this.host) {
      return false
    }
    this.runCycle(true)
    return true
  }

  checkInBackground(): boolean {
    if (!this.host) {
      return false
    }
    this.runCycle(false)
    return true
  }

  /** Hands a staged update to upstream's install path (preflight, cleanup, native swap). */
  quitAndInstall(): boolean {
    const host = this.host
    if (!host) {
      return false
    }
    if (this.phase !== 'staged' || this.installTimer || host.isInstalling()) {
      return true
    }
    this.deps.mac.setPreflightInProgress(true)
    // One tick lets the renderer flush state before windows close, as upstream does.
    this.installTimer = setTimeout(() => {
      this.installTimer = null
      void host.performQuitAndInstall()
    }, this.deps.mac.installDelayMs)
    return true
  }

  /** Called from upstream's install execution in place of electron-updater: Electron's native Squirrel swaps the app. */
  invokeNativeInstall(): boolean {
    if (!this.host || this.phase !== 'staged') {
      return false
    }
    this.phase = 'installing'
    try {
      this.deps.nativeUpdater().quitAndInstall()
    } catch (error) {
      this.phase = 'staged'
      throw error
    }
    return true
  }

  private handleNativeError(error: Error): void {
    // Upstream's install recovery listens to electron-updater, which is not loaded here.
    if (this.phase === 'installing' && this.host?.handleQuitAndInstallFailure(error)) {
      this.phase = 'staged'
    }
  }

  private runCycle(userInitiated: boolean): void {
    const host = this.host
    if (!host || host.isInstalling()) {
      return
    }
    if (this.phase === 'staged' && this.stagedStatus) {
      if (userInitiated) {
        host.sendStatus(this.stagedStatus)
      }
      return
    }
    if (this.phase === 'installing') {
      return
    }
    if (this.cycle) {
      if (userInitiated && !this.userInitiated) {
        this.userInitiated = true
        if (this.phase === 'checking') {
          host.sendStatus({ state: 'checking', userInitiated: true })
        }
      }
      return
    }
    this.userInitiated = userInitiated
    this.cycle = this.performCycle()
      .catch((error: unknown) => {
        this.phase = 'idle'
        this.log('custom_update_cycle_crashed', describeFailureForLog(error))
      })
      .finally(() => {
        this.cycle = null
        this.userInitiated = false
        this.scheduleNext()
      })
  }

  /** Logging must never be what breaks an update check. */
  private log(event: string, data: Record<string, string | undefined>): void {
    try {
      const entries = Object.entries(data).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
      this.deps.log(event, Object.fromEntries(entries))
    } catch {
      // Nothing more to do: the breadcrumb sink is unavailable.
    }
  }

  private async performCycle(): Promise<void> {
    const { host, feed, state } = this
    if (!host || !feed || !state) {
      return
    }
    this.phase = 'checking'
    if (this.userInitiated) {
      host.sendStatus({ state: 'checking', userInitiated: true })
    }
    const attempt = (userInitiated: boolean): Promise<CycleResult> =>
      runUpdateCycle({
        feed,
        host,
        deps: this.deps,
        state,
        userInitiated,
        updatesRoot: this.updatesRoot,
        onDownloadStart: async () => {
          await this.staleCleanup
          this.phase = 'downloading'
        }
      })
    let result = await attempt(this.userInitiated)
    // Only a background check holds a release back, and a click that landed while it waited on the feed is not held
    // to that: run it again as the person's, instead of answering their click with "up to date".
    if (result.outcome === 'none' && result.heldBack && this.userInitiated) {
      result = await attempt(true)
    }
    this.retryInMs = this.retryDelayAfter(result)
    if (result.outcome === 'none') {
      this.settleWithoutUpdate(result.heldBack === true)
    } else if (result.outcome === 'failed') {
      this.phase = 'idle'
      this.reportFailure(result)
    } else {
      const { version } = result.candidate.manifest
      this.phase = 'staged'
      this.stagedStatus = { state: 'downloaded', version, releaseUrl: result.candidate.releaseUrl }
      this.clearTimers()
      host.sendStatus(this.stagedStatus)
    }
  }

  private retryDelayAfter(result: CycleResult): number | null {
    if (result.outcome === 'staged') {
      this.backoff.reset()
    }
    if (result.outcome !== 'failed') {
      return null
    }
    const { failure, candidate, downloadShown } = result
    if (candidate && downloadShown && (failure.kind === 'network' || failure.kind === 'download')) {
      // A cut download costs the whole zip again: wait longer after each failure of the same release.
      return this.backoff.failed(candidate.manifest.version)
    }
    return failure.kind === 'network' ? OFFLINE_RETRY_MS : null
  }

  /** A release held back for now is not "up to date": a background check leaves an error card as it is. */
  private settleWithoutUpdate(heldBack: boolean): void {
    this.phase = 'idle'
    const host = this.host
    if (host && (this.userInitiated || (!heldBack && host.getCurrentStatus().state === 'error'))) {
      host.sendStatus({
        state: 'not-available',
        ...(this.userInitiated ? { userInitiated: true } : {})
      })
    }
  }

  /** Silent unless a user asked or a visible download was under way; every failure is logged. */
  private reportFailure({ failure, candidate, downloadShown }: CycleFailure): void {
    this.log('custom_update_failed', {
      kind: failure.kind,
      version: candidate?.manifest.version,
      ...describeFailureForLog(failure)
    })
    if (this.userInitiated || downloadShown) {
      this.host?.sendStatus(
        customUpdateFailureStatus(failure, {
          version: candidate?.manifest.version,
          userInitiated: this.userInitiated
        })
      )
    }
  }

  private scheduleNext(): void {
    if (!this.host || !this.feed || this.phase === 'staged' || this.phase === 'installing') {
      return
    }
    const jitter = 1 + (this.deps.random() * 2 - 1) * CHECK_JITTER_RATIO
    this.schedule(
      Math.max((this.retryInMs ?? CUSTOM_UPDATE_CHECK_INTERVAL_MS) * jitter, this.feed.retryDelayMs)
    )
  }

  private schedule(delayMs: number): void {
    this.clearTimers()
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null
      this.runCycle(false)
    }, delayMs)
    this.checkTimer.unref()
  }

  private clearTimers(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer)
      this.checkTimer = null
    }
  }
}

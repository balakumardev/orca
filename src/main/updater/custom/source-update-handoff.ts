import type { RpcCallerIdentity } from '../../runtime/rpc/callers/rpc-caller-identity'

export type SourceUpdateHandoffResult = {
  state: 'quitting' | 'deferred' | 'unsupported'
  pid: number
  reason?: string
}

export type SourceUpdateHandoffDependencies = {
  pid: number
  blockingReason(): string | null
  daemonHealthy(): Promise<boolean>
  prepareCheckpoint(): Promise<(() => void) | null>
  scheduleQuit(commit: () => void): void
  holdSessionStarts(): () => void
  quit(): void
}

/** The source updater owns relaunch; this side owns the checkpoint and normal quit. */
export class SourceUpdateHandoff {
  private pending = false
  private releaseStarts: (() => void) | null = null

  constructor(private readonly deps: SourceUpdateHandoffDependencies) {}

  async request(): Promise<SourceUpdateHandoffResult> {
    if (this.pending) {
      return this.defer('handoff-in-progress')
    }
    this.pending = true
    let cancel: (() => void) | null = null
    let scheduled = false
    try {
      const blocker = this.deps.blockingReason()
      if (blocker) {
        return this.defer(blocker)
      }
      if (!(await this.deps.daemonHealthy())) {
        return this.defer('daemon-unavailable')
      }
      cancel = await this.deps.prepareCheckpoint()
      if (!cancel) {
        return this.defer('checkpoint-failed')
      }
      // Preparation yields to new agent launches; inspect ownership again before handing off.
      const changed = this.deps.blockingReason()
      if (changed) {
        return this.defer(changed)
      }
      const release = cancel
      this.deps.scheduleQuit(() => this.commit(release))
      scheduled = true
      cancel = null
      return { state: 'quitting', pid: this.deps.pid }
    } catch (error) {
      console.warn(
        '[source-update] Preparation failed',
        error instanceof Error ? error.name : 'Error'
      )
      return this.defer('preparation-failed')
    } finally {
      if (!scheduled) {
        this.pending = false
      }
      cancel?.()
    }
  }

  private defer(reason: string): SourceUpdateHandoffResult {
    return { state: 'deferred', pid: this.deps.pid, reason }
  }

  private commit(cancel: () => void): void {
    try {
      // Recheck at commit because the reply grace allows new work to arrive.
      if (!this.pending || this.deps.blockingReason()) {
        cancel()
        this.cancel()
        return
      }
      // Hold starts before releasing the renderer checkpoint that otherwise deadlocks normal close.
      this.releaseStarts = this.deps.holdSessionStarts()
      cancel()
      this.deps.quit()
    } catch (error) {
      cancel()
      this.cancel()
      console.warn('[source-update] Quit failed', error instanceof Error ? error.name : 'Error')
    }
  }

  /** A renderer veto reopens admission and lets a later updater tick try again. */
  cancel(): void {
    this.releaseStarts?.()
    this.releaseStarts = null
    this.pending = false
  }
}

let handoff: SourceUpdateHandoff | null = null

/** Only an explicitly managed source desktop installs a handoff. */
export function configureSourceUpdateHandoff(next: SourceUpdateHandoff | null): void {
  handoff?.cancel()
  handoff = next
}

/** Normal quit cancellation must also release the source updater's admission hold. */
export function cancelSourceUpdateQuit(): void {
  handoff?.cancel()
}

/** Paired devices and plugins cannot request a machine-local source updater quit. */
export function requestSourceUpdateQuit(
  caller: RpcCallerIdentity | undefined
): Promise<SourceUpdateHandoffResult> {
  if (caller?.kind !== 'local-cli' || !handoff) {
    return Promise.resolve({ state: 'unsupported', pid: process.pid })
  }
  return handoff.request()
}

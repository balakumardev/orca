import { spawnProcess } from '@orca/process-host'
import { LID_HELPER_PATH } from './lid-awake-helper-source'
import { runLidCommand } from './lid-awake-run-command'

export const LID_HEARTBEAT_MS = 15_000
const HOLD_START_TIMEOUT_MS = 10_000
const RELEASE_GRACE_MS = 3_000

export type HoldOutcome = 'held' | 'busy' | 'foreign' | 'failed' | 'needs-repair'
export type ResetOutcome = 'reset' | 'clean' | 'busy' | 'failed'

export type HoldSession = {
  /** Ends the hold and resolves once the helper has exited (and so cleared the flag). */
  release: () => Promise<void>
}

export type HoldResult =
  | { outcome: 'held'; session: HoldSession }
  | { outcome: Exclude<HoldOutcome, 'held'>; session: null }

export type LidHoldBackend = {
  /** `onUnexpectedExit` fires only when the helper ends without release() having been called. */
  hold: (onUnexpectedExit: () => void) => Promise<HoldResult>
  reset: () => Promise<ResetOutcome>
}

function outcomeFromLine(line: string): HoldOutcome {
  return line === 'held' || line === 'busy' || line === 'foreign' ? line : 'failed'
}

// A missing or broken sudoers rule makes `sudo -n` refuse; that needs the owner's repair, not a retry.
function looksLikeSudoRefusal(stderr: string): boolean {
  return /password is required|terminal is required|not allowed|not in the sudoers/i.test(stderr)
}

/** Runs `sudo -n <helper> hold`; stdin is the lease: a line every 15 s, EOF or silence ends the hold. */
export class SudoLidHoldBackend implements LidHoldBackend {
  hold(onUnexpectedExit: () => void): ReturnType<LidHoldBackend['hold']> {
    return new Promise((resolve) => {
      const child = spawnProcess({
        program: '/usr/bin/sudo',
        args: ['-n', LID_HELPER_PATH, 'hold'],
        stdio: 'pipe'
      })
      let settled = false
      let released = false
      let stdout = ''
      let stderr = ''
      const exited = new Promise<void>((done) => child.once('close', () => done()))
      const heartbeat = setInterval(() => child.stdin.write('\n'), LID_HEARTBEAT_MS)
      child.stdin.on('error', () => {})
      const session: HoldSession = {
        release: async () => {
          released = true
          clearInterval(heartbeat)
          child.stdin.end()
          const killer = setTimeout(() => child.kill('SIGTERM'), RELEASE_GRACE_MS)
          await exited
          clearTimeout(killer)
        }
      }
      const settle = (outcome: HoldOutcome): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(startTimer)
        if (outcome !== 'held') {
          released = true
          clearInterval(heartbeat)
          child.stdin.end()
        }
        resolve(outcome === 'held' ? { outcome, session } : { outcome, session: null })
      }
      const startTimer = setTimeout(() => {
        child.kill('SIGTERM')
        settle('failed')
      }, HOLD_START_TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const line = stdout.split('\n')[0]
        if (stdout.includes('\n')) {
          settle(outcomeFromLine(line.trim()))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2_000)
      })
      child.once('error', () => settle('failed'))
      child.once('close', () => {
        clearInterval(heartbeat)
        if (!settled) {
          settle(looksLikeSudoRefusal(stderr) ? 'needs-repair' : 'failed')
        } else if (!released) {
          onUnexpectedExit()
        }
      })
    })
  }

  async reset(): Promise<ResetOutcome> {
    const stdout = await runLidCommand('/usr/bin/sudo', ['-n', LID_HELPER_PATH, 'reset'], 10_000)
    const line = stdout?.trim()
    return line === 'reset' || line === 'clean' || line === 'busy' ? line : 'failed'
  }
}

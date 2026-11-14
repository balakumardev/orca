import { execFile, type ExecFileException } from 'node:child_process'
import { CustomUpdateError } from './custom-update-errors'

export type CommandResult = {
  code: number
  stdout: string
  stderr: string
  /** The tool ran past its time limit and was stopped; its exit code says nothing about the bundle. */
  timedOut?: boolean
  /**
   * Set when the tool did not run to an exit of its own, so `code` (1) says nothing about the bundle:
   * `spawn-failed` it could not be started (no process, or none to speak of: EAGAIN, ENOMEM, EMFILE, a missing file),
   * `signal` something else killed it (the kernel under memory pressure, a user), `aborted` our own abort did.
   */
  interrupted?: 'spawn-failed' | 'signal' | 'aborted'
}
/** Arguments are always an array: the staging path lives under "Application Support" and has spaces. */
export type CommandRunner = (
  file: string,
  args: string[],
  options?: { signal?: AbortSignal }
) => Promise<CommandResult>

const COMMAND_TIMEOUT_MS = 5 * 60_000
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024
// After an abort the tool gets this long to stop on SIGTERM before it is killed outright.
const HARD_KILL_MS = 1000
// And this long more for the exit to be reported (a child of the tool can hold its output open after the tool is gone).
const GIVE_UP_MS = 3000

// The app's own environment carries a hydrated shell PATH and may carry DEVELOPER_DIR, either of which can
// point `xcrun` at a different `stapler`. Every binary below is addressed by absolute path anyway.
const SYSTEM_COMMAND_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

type ExecError = ExecFileException

function describeResult(
  error: ExecError | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
  abortedByUs: boolean
): CommandResult {
  const base = { code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 }
  const output = { stdout: String(stdout), stderr: String(stderr) }
  if (!error) {
    return { ...base, ...output, timedOut: false }
  }
  // `killed` is set when our own kill ended it: the time limit, or the abort handled below.
  const timedOut = error.killed === true && !abortedByUs
  if (abortedByUs) {
    return { ...base, ...output, timedOut: false, interrupted: 'aborted' }
  }
  if (typeof error.code === 'string' && error.syscall?.startsWith('spawn')) {
    return { ...base, ...output, timedOut: false, interrupted: 'spawn-failed' }
  }
  if (!timedOut && typeof error.signal === 'string') {
    return { ...base, ...output, timedOut: false, interrupted: 'signal' }
  }
  return { ...base, ...output, timedOut }
}

/**
 * `hardKillMs` is how long a tool that was asked to stop (our abort) has before it is killed. The runner answers only
 * once the tool has exited, so a caller that deletes what the tool was writing to cannot race a tool that is still
 * running; the abort of `execFile` itself answers at once, which is why it is handled here.
 */
export function createCommandRunner(
  timeoutMs: number,
  hardKillMs: number = HARD_KILL_MS
): CommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      let abortedByUs = false
      let settled = false
      const timers: ReturnType<typeof setTimeout>[] = []
      const signal = options?.signal
      const settle = (result: CommandResult): void => {
        if (settled) {
          return
        }
        settled = true
        timers.forEach(clearTimeout)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = (): void => {
        abortedByUs = true
        child.kill('SIGTERM')
        timers.push(
          setTimeout(() => child.kill('SIGKILL'), hardKillMs),
          setTimeout(
            () =>
              settle({ code: 1, stdout: '', stderr: '', timedOut: false, interrupted: 'aborted' }),
            hardKillMs + GIVE_UP_MS
          )
        )
      }
      const child = execFile(
        file,
        args,
        { timeout: timeoutMs, maxBuffer: COMMAND_MAX_BUFFER, env: SYSTEM_COMMAND_ENV },
        (error, stdout, stderr) => settle(describeResult(error, stdout, stderr, abortedByUs))
      )
      if (signal?.aborted) {
        onAbort()
      } else {
        signal?.addEventListener('abort', onAbort, { once: true })
      }
    })
}

export const runSystemCommand: CommandRunner = createCommandRunner(COMMAND_TIMEOUT_MS)

/**
 * A tool that was stopped for taking too long (a busy disk, a stuck Gatekeeper), could not be started, or was killed
 * by something else says nothing about the bundle, so none of that may be read as a failed check: it is a retryable
 * `check-timeout` or `check-error`, and repeated ones count as strikes. A tool that our own abort stopped passes
 * through: the caller that aborted it knows why.
 */
export function failOnInterruption(run: CommandRunner): CommandRunner {
  return async (file, args, options) => {
    const result = await run(file, args, options)
    if (result.timedOut) {
      throw new CustomUpdateError(
        'check-timeout',
        'A tool took too long while the update was checked'
      )
    }
    if (result.interrupted === 'spawn-failed' || result.interrupted === 'signal') {
      throw new CustomUpdateError(
        'check-error',
        'A tool could not finish while the update was checked'
      )
    }
    return result
  }
}

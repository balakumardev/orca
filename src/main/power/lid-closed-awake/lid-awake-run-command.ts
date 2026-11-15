import { runProcess } from '@orca/process-host'

/** Stdout of a command that exited 0 within the time limit; null for anything else. */
export async function runLidCommand(
  program: string,
  args: readonly string[],
  timeoutMs: number
): Promise<string | null> {
  try {
    const result = await runProcess({ program, args, timeoutMs })
    return result.code === 0 && !result.timedOut ? result.stdout : null
  } catch {
    return null
  }
}

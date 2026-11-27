import { assertSourceUpdateSessionStartAllowed } from './source-update-session-admission'

let outstanding = 0

/** Include queued work and cancelled starts until their acquisition cleanup actually finishes. */
export function track<T>(work: Promise<T>): Promise<T> {
  outstanding++
  const settled = (): void => {
    outstanding--
  }
  void work.then(settled, settled)
  return work
}

/** Reserve synchronously before any provider start can yield to the updater's census. */
export async function start<T>(
  run: () => Promise<T> | undefined,
  unavailable?: string
): Promise<T> {
  assertSourceUpdateSessionStartAllowed()
  const work = run()
  if (!work) {
    throw new Error(unavailable)
  }
  return track(work)
}

/** An initialized host is idle once its admitted operations have settled. */
export const pending = (): boolean => outstanding > 0

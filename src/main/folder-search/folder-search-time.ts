export const TIMED_OUT = Symbol('folder-search-timed-out')

/** How long one file system call may take before the search stops waiting for it. */
export const FOLDER_SEARCH_CALL_TIMEOUT_MS = 500

/**
 * A call on a dead mount never settles, and Node cannot cancel it. The caller stops waiting; the call
 * itself stays pending and can hold one of the few file system threads until the mount answers.
 */
export async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

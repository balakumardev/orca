export type ActivityCycleDirection = 'previous' | 'next'

/** Wraps at both ends; with no usable selection, next starts at the first row and previous at the last. */
export function cycleActivityThread<T extends { paneKey: string }>(
  threads: readonly T[],
  selectedPaneKey: string | null,
  direction: ActivityCycleDirection
): T | null {
  if (threads.length === 0) {
    return null
  }
  const selectedIndex = threads.findIndex((thread) => thread.paneKey === selectedPaneKey)
  if (selectedIndex === -1) {
    return (direction === 'next' ? threads.at(0) : threads.at(-1)) ?? null
  }
  const step = direction === 'next' ? 1 : -1
  return threads[(selectedIndex + step + threads.length) % threads.length]
}

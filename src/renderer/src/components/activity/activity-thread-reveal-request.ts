const ACTIVITY_THREAD_REVEAL_EVENT = 'orca-custom:activity-thread-reveal'

type ActivityThreadRevealDetail = { paneKey: string }

/** Ask the mounted Activity list to scroll a thread's row into view; the highlight itself is set elsewhere. */
export function requestActivityThreadReveal(paneKey: string): void {
  window.dispatchEvent(
    new CustomEvent<ActivityThreadRevealDetail>(ACTIVITY_THREAD_REVEAL_EVENT, {
      detail: { paneKey }
    })
  )
}

function isActivityThreadRevealEvent(
  event: Event
): event is CustomEvent<ActivityThreadRevealDetail> {
  return event instanceof CustomEvent && typeof event.detail?.paneKey === 'string'
}

export function subscribeToActivityThreadReveal(listener: (paneKey: string) => void): () => void {
  const onReveal = (event: Event): void => {
    if (isActivityThreadRevealEvent(event)) {
      listener(event.detail.paneKey)
    }
  }
  window.addEventListener(ACTIVITY_THREAD_REVEAL_EVENT, onReveal)
  return () => window.removeEventListener(ACTIVITY_THREAD_REVEAL_EVENT, onReveal)
}

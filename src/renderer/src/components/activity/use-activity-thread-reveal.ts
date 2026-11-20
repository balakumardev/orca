import { useEffect, useReducer, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { subscribeToActivityThreadReveal } from './activity-thread-reveal-request'
import {
  findActivityThreadItemIndex,
  type ActivityVirtualItemDescriptor
} from './thread-list/activity-thread-virtual-items'

/**
 * Scrolls a requested row into view once the render that shows it has committed. The request is a
 * window event, so only the list the follow belongs to (the sidebar's) listens; any other Activity
 * list mounted at the same time (the full-page one) stays where it is.
 */
export function useActivityThreadReveal(
  virtualItems: readonly ActivityVirtualItemDescriptor[],
  virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, 'scrollToIndex'>,
  enabled: boolean
): void {
  const pendingPaneKeyRef = useRef<string | null>(null)
  // Each request renders once, so asking for the same row twice scrolls twice.
  const [requestCount, countRequest] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    if (!enabled) {
      return
    }
    return subscribeToActivityThreadReveal((paneKey) => {
      pendingPaneKeyRef.current = paneKey
      countRequest()
    })
  }, [enabled])
  useEffect(() => {
    const paneKey = pendingPaneKeyRef.current
    if (paneKey === null) {
      return
    }
    pendingPaneKeyRef.current = null
    const index = findActivityThreadItemIndex(virtualItems, paneKey)
    if (index !== null) {
      virtualizer.scrollToIndex(index, { align: 'auto' })
    }
  }, [requestCount, virtualItems, virtualizer])
}

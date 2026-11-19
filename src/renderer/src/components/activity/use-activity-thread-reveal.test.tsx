// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'
import { requestActivityThreadReveal } from './activity-thread-reveal-request'
import type { AgentPaneThread } from './threads/activity-thread-types'
import type { ActivityVirtualItemDescriptor } from './thread-list/activity-thread-virtual-items'
import { useActivityThreadReveal } from './use-activity-thread-reveal'

function makeThread(paneKey: string): AgentPaneThread {
  return {
    paneKey,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1000,
    agentType: 'claude',
    unread: false,
    paneTitle: paneKey,
    responsePreview: '',
    events: []
  }
}

const ITEMS: ActivityVirtualItemDescriptor[] = [
  { type: 'thread', thread: makeThread('tab-1:leaf-a'), groupKey: 'all' },
  { type: 'thread', thread: makeThread('tab-2:leaf-b'), groupKey: 'all' }
]

describe('useActivityThreadReveal', () => {
  it('scrolls a requested row into view, as little as needed, and again for a repeated request', () => {
    const scrollToIndex = vi.fn()
    renderHook(() => useActivityThreadReveal(ITEMS, { scrollToIndex }, true))

    act(() => requestActivityThreadReveal('tab-2:leaf-b'))
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'auto' })

    act(() => requestActivityThreadReveal('tab-2:leaf-b'))
    expect(scrollToIndex).toHaveBeenCalledTimes(2)
  })

  it('ignores a row that is not in the list', () => {
    const scrollToIndex = vi.fn()
    renderHook(() => useActivityThreadReveal(ITEMS, { scrollToIndex }, true))

    act(() => requestActivityThreadReveal('tab-9:leaf-z'))

    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('does nothing in a list that is not the sidebar’s', () => {
    const scrollToIndex = vi.fn()
    renderHook(() => useActivityThreadReveal(ITEMS, { scrollToIndex }, false))

    act(() => requestActivityThreadReveal('tab-1:leaf-a'))

    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('stops listening when it unmounts', () => {
    const scrollToIndex = vi.fn()
    const { unmount } = renderHook(() => useActivityThreadReveal(ITEMS, { scrollToIndex }, true))
    unmount()

    act(() => requestActivityThreadReveal('tab-1:leaf-a'))

    expect(scrollToIndex).not.toHaveBeenCalled()
  })
})

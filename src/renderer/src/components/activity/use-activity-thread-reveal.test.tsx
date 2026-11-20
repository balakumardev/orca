// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { requestActivityThreadReveal } from './activity-thread-reveal-request'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AgentPaneThread } from './threads/activity-thread-types'
import type { ActivityVirtualItemDescriptor } from './thread-list/activity-thread-virtual-items'
import { useActivityThreadReveal } from './use-activity-thread-reveal'

function makeTab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeWorktree(): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

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

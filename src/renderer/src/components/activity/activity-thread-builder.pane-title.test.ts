import { describe, expect, it } from 'vitest'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildActivityEvents } from './events/activity-event-builder'
import { buildAgentPaneThreads } from './threads/activity-thread-builder'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

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

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
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

function makeWorkingEntryWithoutHistory(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'New run',
    updatedAt: 3_000,
    stateStartedAt: 3_000,
    paneKey: PANE_KEY,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude'
  }
}

function makeActivityResult(args: {
  entries?: Record<string, AgentStatusEntry>
  tab?: TerminalTab
}): ReturnType<typeof buildActivityEvents> {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tab = args.tab ?? makeTab()

  return buildActivityEvents({
    chatNames: new Map(),
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries(args.entries ?? {})),
    tabsByWorktree: { [worktree.id]: [tab] },
    worktreeMap: new Map([[worktree.id, worktree]]),
    repoMap: new Map([[repo.id, repo]]),
    acknowledgedAgentsByPaneKey: {},
    now: 3_000
  })
}

// Why: tab.title carries only the focused pane's title; here the focused pane is the sibling.
const SIBLING_FOCUSED_TAB = { ...makeTab(), title: '✳ Sibling task' }

const SPLIT_LAYOUT: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: LEAF_ID },
    second: { type: 'leaf', leafId: LEAF_ID_2 }
  },
  activeLeafId: LEAF_ID_2,
  expandedLeafId: null
}

function threadTitle(args: {
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
}): string | undefined {
  const result = makeActivityResult({
    entries: { [PANE_KEY]: makeWorkingEntryWithoutHistory() },
    tab: SIBLING_FOCUSED_TAB
  })
  const threads = buildAgentPaneThreads({
    events: result.events,
    liveAgentByPaneKey: result.liveAgentByPaneKey,
    paneEntryByPaneKey: result.paneEntryByPaneKey,
    ...args
  })
  return threads.find((thread) => thread.paneKey === PANE_KEY)?.paneTitle
}

describe('buildAgentPaneThreads pane title in split tabs', () => {
  it('uses the row pane own session title, not the focused sibling tab title', () => {
    expect(
      threadTitle({
        terminalLayoutsByTabId: { 'tab-1': SPLIT_LAYOUT },
        runtimePaneTitlesByTabId: { 'tab-1': { 1: '✳ Own task', 2: '✳ Sibling task' } }
      })
    ).toBe('Own task')
  })

  it('falls back to the prompt when the row pane title cannot be resolved', () => {
    expect(
      threadTitle({
        terminalLayoutsByTabId: { 'tab-1': SPLIT_LAYOUT },
        runtimePaneTitlesByTabId: { 'tab-1': { 2: '✳ Sibling task' } }
      })
    ).toBe('New run')
  })

  it('keeps the tab title for a single-pane tab', () => {
    expect(threadTitle({})).toBe('Sibling task')
  })
})

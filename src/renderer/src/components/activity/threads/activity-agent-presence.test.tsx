// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { AgentSessionStatusEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { clearActivityThread } from '../thread-list/activity-clear-completed'
import { activityThreadStatusId } from './activity-thread-presentation'
import { useAgentPaneThreads } from './use-agent-pane-threads'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

function makeRepo(): Repo {
  return { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '#000', addedAt: 1 }
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

function makeTabWithIds(id: string, worktreeId: string, title: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})

const statusListeners = vi.hoisted(
  () => new Map<string, (event: AgentSessionStatusEvent) => void>()
)
vi.mock('@/runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: async (
    target: RuntimeClientTarget,
    receive: (event: AgentSessionStatusEvent) => void
  ) => {
    const owner = target.kind === 'local' ? 'local' : target.environmentId
    statusListeners.set(owner, receive)
    return { unsubscribe: () => statusListeners.delete(owner) }
  }
}))

function withStatus(paneKey: string, status: AgentStatusEntry) {
  return acceptedAgentStatuses([...useAppStore.getState().agentStatusByPaneKey, [paneKey, status]])
}

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  statusListeners.clear()
  vi.restoreAllMocks()
})

it.each(['local', 'ssh:intbox', 'runtime:managed', 'runtime:paired'] as const)(
  'retains confirmed idle agents on %s through clearing history and retires shell presence',
  (hostId) => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const repo = makeRepo()
    const worktree = makeWorktree()
    repo.executionHostId = hostId
    worktree.hostId = hostId
    const tabs = ['opened', 'manual', 'finished', 'launch-only', 'shell'].map((id) =>
      makeTabWithIds(id, worktree.id, 'OpenCode')
    )
    const entry = (id: string, boundary = true): AgentStatusEntry => ({
      paneKey: makePaneKey(id, LEAF_ID),
      state: 'done',
      agentType: 'opencode',
      prompt: '',
      sessionBoundary: boundary,
      updatedAt: 2_000,
      stateStartedAt: 2_000,
      // Answering a late question can restore the turn's earlier completion timestamp.
      stateHistory:
        id === 'finished'
          ? [{ state: 'waiting', prompt: 'Confirm the result', startedAt: 3_000 }]
          : []
    })
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: tabs },
      unifiedTabsByWorktree: {
        [worktree.id]: tabs.map((tab) => ({
          id: `unified-${tab.id}`,
          entityId: tab.id,
          contentType: 'terminal',
          executionHostId: hostId,
          worktreeId: worktree.id,
          groupId: 'group-1',
          label: tab.title,
          customLabel: null,
          color: null,
          createdAt: tab.createdAt,
          sortOrder: 0
        }))
      },
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map((tab) => [
          tab.id,
          { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: LEAF_ID, expandedLeafId: null }
        ])
      ),
      ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.ptyId!]])),
      paneForegroundAgentByPaneKey: Object.fromEntries(
        tabs.map((tab) => [
          makePaneKey(tab.id, LEAF_ID),
          {
            agent: tab.id === 'shell' ? null : 'opencode',
            agentEvidence: tab.id === 'launch-only' ? 'launch-record' : 'process-read',
            shellForeground: tab.id === 'shell'
          }
        ])
      ),
      agentStatusByPaneKey: acceptedAgentStatuses(
        tabs
          .filter((tab) => tab.id !== 'manual')
          .map((tab) => [makePaneKey(tab.id, LEAF_ID), entry(tab.id, tab.id !== 'finished')])
      ),
      migrationUnsupportedByPtyId: {},
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {
        [makePaneKey('opened', LEAF_ID)]: {
          parentPaneKey: makePaneKey('finished', LEAF_ID),
          taskId: 'task',
          dispatchId: 'dispatch'
        }
      },
      agentsVisibleHostIds: null,
      agentsFilterRepoIds: [],
      agentsHideWorkspacesFromOtherDevices: false,
      agentsHideAutomationGeneratedWorkspaces: false,
      agentsHideCliCreatedWorkspaces: false
    })
    // A split's live sibling must not admit an old binding or lend its shell title to the agent.
    useAppStore.setState((state) => ({
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        manual: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF_ID },
            second: { type: 'leaf', leafId: LEAF_ID_2 }
          },
          activeLeafId: LEAF_ID_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-manual', [LEAF_ID_2]: 'pty-retired' }
        }
      },
      runtimePaneTitlesByTabId: { manual: { 2: 'zsh' } },
      paneForegroundAgentByPaneKey: {
        ...state.paneForegroundAgentByPaneKey,
        [makePaneKey('manual', LEAF_ID_2)]: {
          agent: 'opencode',
          agentEvidence: 'process-read',
          shellForeground: false
        }
      }
    }))
    const activity = renderHook(
      (query: string) =>
        useAgentPaneThreads({
          query,
          readFilter: 'all',
          groupBy: 'none',
          selectedPaneKey: null,
          showChildAgents: false
        }),
      { initialProps: '' }
    )
    const rows = () =>
      activity.result.current.visibleThreads
        .map((thread) => [thread.tab.id, activityThreadStatusId(thread), thread.unread])
        .sort(([left], [right]) => String(left).localeCompare(String(right)))

    expect(rows()).toEqual([
      ['finished', 'idle', true],
      ['manual', 'idle', false],
      ['opened', 'idle', false]
    ])
    act(() => {
      const finished = activity.result.current.visibleThreads.find(
        (thread) => thread.tab.id === 'finished'
      )!
      expect(clearActivityThread(finished)).toBe(true)
    })
    expect(rows()).toEqual([
      ['finished', 'idle', false],
      ['manual', 'idle', false],
      ['opened', 'idle', false]
    ])

    activity.rerender('does not match')
    expect(rows()).toEqual([])
    activity.rerender('')
    act(() => useAppStore.setState({ agentsVisibleHostIds: ['ssh:other'] }))
    expect(rows()).toEqual([])
    act(() => useAppStore.setState({ agentsVisibleHostIds: [hostId] }))

    act(() =>
      useAppStore.getState().setPaneForegroundAgent(makePaneKey('manual', LEAF_ID), {
        agent: null,
        shellForeground: true
      })
    )
    expect(rows()).toEqual([
      ['finished', 'idle', false],
      ['opened', 'idle', false]
    ])
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: withStatus(makePaneKey('opened', LEAF_ID), {
          ...entry('opened', false),
          state: 'working',
          updatedAt: 100_000,
          stateStartedAt: 100_000
        })
      })
    )
    expect(rows()).toEqual([
      ['finished', 'idle', false],
      ['opened', 'working', true]
    ])
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: withStatus(makePaneKey('opened', LEAF_ID), {
          ...entry('opened', false),
          state: 'waiting',
          updatedAt: -2_000_000,
          stateHistory: [{ state: 'done', prompt: 'Previous turn', startedAt: 1_500 }]
        })
      })
    )
    expect(rows()).toEqual([
      ['finished', 'idle', false],
      ['opened', 'waiting', true]
    ])
    expect(
      clearActivityThread(
        activity.result.current.visibleThreads.find((thread) => thread.tab.id === 'opened')!
      )
    ).toBe(false)
  }
)

it('lists a host-owned native agent before its first turn, but not drafts or disconnected presence', async () => {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tabs: Tab[] = ['live-chat', 'draft-chat'].map((id) => ({
    id,
    entityId: id,
    contentType: 'agent-session',
    groupId: 'group-1',
    worktreeId: worktree.id,
    executionHostId: 'local',
    agentSessionAgent: 'claude',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1_000
  }))
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    tabsByWorktree: {},
    unifiedTabsByWorktree: { [worktree.id]: tabs },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        structuredAgentSessionPaneKey('live-chat', 'live-chat'),
        {
          paneKey: structuredAgentSessionPaneKey('live-chat', 'live-chat'),
          state: 'done',
          agentType: 'claude',
          prompt: '',
          sessionBoundary: true,
          restoredUnconfirmed: true,
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          stateHistory: []
        }
      ]
    ]),
    paneForegroundAgentByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    agentsVisibleHostIds: null,
    agentsFilterRepoIds: []
  })
  const activity = renderHook(() =>
    useAgentPaneThreads({
      query: '',
      readFilter: 'all',
      groupBy: 'none',
      selectedPaneKey: null
    })
  )
  expect(activity.result.current.visibleThreads).toEqual([])
  await act(async () =>
    statusListeners.get('local')!({
      type: 'snapshot',
      sessions: tabs.map((tab) => ({
        sessionId: tab.entityId,
        workspaceId: worktree.id,
        agent: 'claude',
        status: null,
        latestPrompt: '',
        updatedAt: 2_000,
        ...(tab.id === 'live-chat' ? { hostExecutionOwned: true as const } : {})
      }))
    })
  )
  expect(
    activity.result.current.visibleThreads.map((thread) => [
      thread.tab.id,
      activityThreadStatusId(thread),
      thread.unread,
      thread.events.length
    ])
  ).toEqual([['live-chat', 'idle', false, 0]])
  act(() => statusListeners.get('local')!({ type: 'end' }))
  expect(activity.result.current.visibleThreads).toEqual([])
})

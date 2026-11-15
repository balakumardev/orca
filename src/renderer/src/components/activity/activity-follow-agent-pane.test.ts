import { describe, expect, it } from 'vitest'
import type { FocusedAgentRowHighlightState } from '@/components/sidebar/workspace-card/activity/focused-agent-row-highlight'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getFollowedAgentPaneKey } from './activity-follow-agent-pane'
import {
  LEAF_ID,
  LEAF_ID_2,
  LEAF_ID_3,
  makeTabWithIds
} from './ActivityPrototypePage-test-fixtures'

const PANE_A = makePaneKey('tab-1', LEAF_ID)
const PANE_B = makePaneKey('tab-1', LEAF_ID_2)
const PANE_C = makePaneKey('tab-1', LEAF_ID_3)
const OTHER_TAB_PANE = makePaneKey('tab-2', LEAF_ID)

function statusEntry(paneKey: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    state,
    prompt: 'prompt',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    paneKey,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude'
  }
}

// Tab 1 splits into panes A and B (and C when asked); `focused` is the leaf the store has focused.
function makeState(options: {
  focused: string
  agents: Record<string, AgentStatusEntry['state']>
  withThirdPane?: boolean
}): FocusedAgentRowHighlightState {
  const split = (first: string, second: string) => ({
    type: 'split' as const,
    direction: 'vertical' as const,
    first: { type: 'leaf' as const, leafId: first },
    second: { type: 'leaf' as const, leafId: second }
  })
  return {
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    getActiveTab: () => null,
    tabsByWorktree: {
      'wt-1': [makeTabWithIds('tab-1', 'wt-1'), makeTabWithIds('tab-2', 'wt-1')]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: options.withThirdPane
          ? {
              type: 'split',
              direction: 'horizontal',
              first: split(LEAF_ID, LEAF_ID_2),
              second: { type: 'leaf', leafId: LEAF_ID_3 }
            }
          : split(LEAF_ID, LEAF_ID_2),
        activeLeafId: options.focused,
        expandedLeafId: null
      }
    },
    agentStatusByPaneKey: Object.fromEntries(
      Object.entries(options.agents).map(([paneKey, state]) => [
        paneKey,
        statusEntry(paneKey, state)
      ])
    ),
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {}
  }
}

describe('getFollowedAgentPaneKey', () => {
  it('follows the focused pane when it runs an agent', () => {
    const state = makeState({
      focused: LEAF_ID,
      agents: { [PANE_A]: 'working', [PANE_B]: 'working' }
    })

    expect(getFollowedAgentPaneKey(state)).toBe(PANE_A)
  })

  it('follows the tab’s only running agent when the focused pane has none', () => {
    const state = makeState({ focused: LEAF_ID, agents: { [PANE_B]: 'working' } })

    expect(getFollowedAgentPaneKey(state)).toBe(PANE_B)
  })

  it('ignores status rows of panes that are not in the tab, and agents of other tabs', () => {
    const ghostPane = makePaneKey('tab-1', '99999999-9999-4999-8999-999999999999')
    const state = makeState({
      focused: LEAF_ID,
      agents: { [PANE_B]: 'blocked', [ghostPane]: 'working', [OTHER_TAB_PANE]: 'working' }
    })

    expect(getFollowedAgentPaneKey(state)).toBe(PANE_B)
  })

  it('keeps the highlight where it is when two agents run and the focused pane has none', () => {
    const state = makeState({
      focused: LEAF_ID,
      withThirdPane: true,
      agents: { [PANE_B]: 'working', [PANE_C]: 'waiting' }
    })

    expect(getFollowedAgentPaneKey(state)).toBeNull()
  })

  it('keeps the highlight when the only agent in the tab has finished', () => {
    const state = makeState({ focused: LEAF_ID, agents: { [PANE_B]: 'done' } })

    expect(getFollowedAgentPaneKey(state)).toBeNull()
  })

  it('prefers the one running agent over a finished snapshot in the focused pane', () => {
    const state = makeState({
      focused: LEAF_ID,
      agents: { [PANE_A]: 'done', [PANE_B]: 'working' }
    })

    expect(getFollowedAgentPaneKey(state)).toBe(PANE_B)
  })

  it('stays on a finished focused pane when nothing else is running, or when several are', () => {
    const idle = makeState({ focused: LEAF_ID, agents: { [PANE_A]: 'done', [PANE_B]: 'done' } })
    const crowded = makeState({
      focused: LEAF_ID,
      withThirdPane: true,
      agents: { [PANE_A]: 'done', [PANE_B]: 'working', [PANE_C]: 'working' }
    })

    expect(getFollowedAgentPaneKey(idle)).toBe(PANE_A)
    expect(getFollowedAgentPaneKey(crowded)).toBe(PANE_A)
  })

  it('follows nothing outside the terminal view or without an active workspace', () => {
    const base = makeState({ focused: LEAF_ID, agents: { [PANE_B]: 'working' } })

    expect(getFollowedAgentPaneKey({ ...base, activeTabType: 'editor' })).toBeNull()
    expect(getFollowedAgentPaneKey({ ...base, activeWorktreeId: null })).toBeNull()
  })
})

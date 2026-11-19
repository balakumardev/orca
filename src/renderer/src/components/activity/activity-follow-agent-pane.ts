import {
  getFocusedAgentPaneKeyForWorktree,
  type FocusedAgentRowHighlightState
} from '@/components/sidebar/workspace-card/activity/focused-agent-row-highlight'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

/** Whether the pane's agent is still running; a finished one only leaves a snapshot row behind. */
function paneHasLiveAgent(state: FocusedAgentRowHighlightState, paneKey: string): boolean {
  const entry = state.agentStatusByPaneKey.get(paneKey)
  return entry !== undefined && entry.state !== 'done'
}

function liveAgentPaneKeysInActiveTab(
  state: FocusedAgentRowHighlightState,
  worktreeId: string
): string[] {
  const tabId = state.activeTabId
  if (state.activeTabType !== 'terminal' || !tabId) {
    return []
  }
  if (!(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)) {
    return []
  }
  return collectLeafIds(state.terminalLayoutsByTabId[tabId]?.root)
    .filter(isTerminalLeafId)
    .map((leafId) => makePaneKey(tabId, leafId))
    .filter((paneKey) => paneHasLiveAgent(state, paneKey))
}

/**
 * The agent pane the Activity highlight should be on: the focused pane's agent, except that a tab with
 * exactly one running agent stands in for a focused pane that has none (Cmd+J lands on the tab's stored
 * pane, not the agent's) or only a finished one. Two or more running agents leave the choice to focus.
 */
export function getFollowedAgentPaneKey(state: FocusedAgentRowHighlightState): string | null {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const focusedPaneKey = getFocusedAgentPaneKeyForWorktree(state, worktreeId)
  if (focusedPaneKey !== null && paneHasLiveAgent(state, focusedPaneKey)) {
    return focusedPaneKey
  }
  const liveInTab = liveAgentPaneKeysInActiveTab(state, worktreeId)
  return liveInTab.length === 1 ? liveInTab[0] : focusedPaneKey
}

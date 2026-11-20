import { useContext, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { ActivityGroupBy } from '../../../../shared/agent-status/presentation/agents-view-thread-filters'
import { getFollowedAgentPaneKey } from './activity-follow-agent-pane'
import {
  decideActivityFollow,
  findCollapsedGroupKeyHolding,
  type ActivityFollowMemory
} from './activity-follow-focused-agent'
import { ActivityThreadCollapseContext } from './thread-list/activity-thread-collapse-context'
import { requestActivityThreadReveal } from './activity-thread-reveal-request'
import type { ActivityThreadGroup, AgentPaneThread } from './threads/activity-thread-types'

/** Moves the sidebar Activity highlight to the followed agent (see getFollowedAgentPaneKey), and shows its row after a change. Highlight only: the workspace and tab are already active. */
export function useActivityFollowFocusedAgent({
  active,
  groupBy,
  visibleThreads,
  visibleThreadGroups,
  selectedPaneKey,
  setSelectedPaneKey
}: {
  active: boolean
  groupBy: ActivityGroupBy
  visibleThreads: readonly AgentPaneThread[]
  visibleThreadGroups: readonly ActivityThreadGroup[]
  selectedPaneKey: string | null
  setSelectedPaneKey: (paneKey: string | null) => void
}): void {
  const collapse = useContext(ActivityThreadCollapseContext)
  const focusedPaneKey = useAppStore(getFollowedAgentPaneKey)
  const focusedRowListed =
    focusedPaneKey !== null && visibleThreads.some((thread) => thread.paneKey === focusedPaneKey)
  const memoryRef = useRef<ActivityFollowMemory>({
    adoptedPaneKey: null,
    previousSelectedPaneKey: selectedPaneKey,
    followedPaneKey: null,
    wasActive: false
  })

  useEffect(() => {
    const decision = decideActivityFollow({
      ...memoryRef.current,
      active,
      focusedPaneKey,
      selectedPaneKey,
      focusedRowListed
    })
    memoryRef.current = decision.memory
    const paneKey = decision.highlightPaneKey
    if (paneKey === null) {
      return
    }
    setSelectedPaneKey(paneKey)
    if (!decision.reveal) {
      return
    }
    const collapsedGroupKey = findCollapsedGroupKeyHolding(
      visibleThreadGroups,
      groupBy,
      collapse?.collapsedGroupKeys ?? new Set(),
      paneKey
    )
    if (collapsedGroupKey !== null) {
      // Only a group the committed state shows collapsed is toggled, so the toggle can only open it.
      collapse?.onToggleGroupCollapse(collapsedGroupKey)
    }
    requestActivityThreadReveal(paneKey)
  }, [
    active,
    focusedPaneKey,
    selectedPaneKey,
    focusedRowListed,
    groupBy,
    visibleThreadGroups,
    collapse,
    setSelectedPaneKey
  ])
}

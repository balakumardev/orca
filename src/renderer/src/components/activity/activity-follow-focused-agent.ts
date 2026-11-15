import type { ActivityGroupBy } from '../../../../shared/agents-view-thread-filters'
import type { ActivityThreadGroup } from './activity-thread-types'

export type ActivityFollowMemory = {
  /** The focused agent pane the list last reconciled with; null while no agent pane is focused. */
  adoptedPaneKey: string | null
  /** The highlight of the previous evaluation, to tell an explicit selection from a follow. */
  previousSelectedPaneKey: string | null
  /** The row the last follow asked to highlight, until the next selection change shows it landed. */
  followedPaneKey: string | null
  /** Whether the previous evaluation ran with the list showing; false right after it mounts or reopens. */
  wasActive: boolean
}

export type ActivityFollowInput = ActivityFollowMemory & {
  active: boolean
  /** The agent pane the user is working in: active workspace, active terminal tab, its focused pane. */
  focusedPaneKey: string | null
  selectedPaneKey: string | null
  /** Whether the focused pane's agent has a row in the list as filtered right now. */
  focusedRowListed: boolean
}

export type ActivityFollowDecision = {
  /** The row to highlight; null leaves the highlight alone. */
  highlightPaneKey: string | null
  /** Whether to scroll the row in and open its group: only for a change seen while the list was showing, never for a reopen. */
  reveal: boolean
  memory: ActivityFollowMemory
}

/**
 * Keeps the Activity highlight on the agent of the focused pane. It acts when the focused agent pane
 * changes, never on a pane without an agent (the highlight stays), and never against an explicit
 * selection: a click or chord activates a workspace and tab before the pane focus settles, and that
 * passing focus belongs to the selection.
 */
export function decideActivityFollow(input: ActivityFollowInput): ActivityFollowDecision {
  const { focusedPaneKey, selectedPaneKey, focusedRowListed } = input
  const selectionChanged = selectedPaneKey !== input.previousSelectedPaneKey
  // The follow's own write lands as the next selection change, and that change alone is not explicit.
  const explicitSelection =
    selectionChanged && selectedPaneKey !== null && selectedPaneKey !== input.followedPaneKey
  const settled = (adoptedPaneKey: string | null): ActivityFollowDecision => ({
    highlightPaneKey: null,
    reveal: false,
    memory: {
      adoptedPaneKey,
      previousSelectedPaneKey: selectedPaneKey,
      followedPaneKey: selectionChanged ? null : input.followedPaneKey,
      wasActive: input.active
    }
  })
  if (!input.active || focusedPaneKey === null) {
    return settled(null)
  }
  if (focusedPaneKey === selectedPaneKey || explicitSelection) {
    return settled(focusedPaneKey)
  }
  // A highlight the user chose elsewhere stays until the focus moves again.
  if (focusedPaneKey === input.adoptedPaneKey && selectedPaneKey !== null) {
    return settled(focusedPaneKey)
  }
  // The row may appear a render after the pane reports its first status.
  if (!focusedRowListed) {
    return settled(input.adoptedPaneKey)
  }
  return {
    highlightPaneKey: focusedPaneKey,
    // A list that was hidden or just mounted keeps the scroll offset and collapsed groups it retained.
    reveal: input.wasActive,
    memory: {
      adoptedPaneKey: focusedPaneKey,
      previousSelectedPaneKey: selectedPaneKey,
      followedPaneKey: focusedPaneKey,
      wasActive: true
    }
  }
}

/** The group to open so the row shows; null when the row is not in a collapsed group. */
export function findCollapsedGroupKeyHolding(
  groups: readonly ActivityThreadGroup[],
  groupBy: ActivityGroupBy,
  collapsedGroupKeys: ReadonlySet<string>,
  paneKey: string
): string | null {
  if (groupBy === 'none') {
    return null
  }
  const group = groups.find((candidate) =>
    candidate.threads.some((thread) => thread.paneKey === paneKey)
  )
  return group && collapsedGroupKeys.has(group.key) ? group.key : null
}

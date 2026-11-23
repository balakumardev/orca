import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-authority/pane-foreground-agent'
import {
  getStructuredAgentSessionTabsByPaneKey,
  structuredTabsByPaneKey
} from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { resolveAgentRowPaneLiveTitle } from '../../dashboard/rows/agent-row-pane-live-title'
import { resolveTitleDerivedPaneAgent } from '../../sidebar/workspace-card/activity/title-derived-pane-agent-identity'
import { isAgentStatusFresh } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import { parseAgentStatusPaneIdentity } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { ActivityLiveAgentSnapshot } from '../threads/activity-thread-types'
import { resolvePaneBuild, type ActivityEventBuildCache } from './activity-event-build-cache'
import type { BuildActivityEventsArgs } from './activity-event-builder'
import type { ActivityEventOwner, ActivityTabContext } from './activity-event-builder-context'
import { isAgentProcessForeground } from './activity-terminal-presence-inputs'

/** A sibling's live shell and a remembered launch cannot establish this pane's agent presence. */
function terminalPresenceAgent(args: {
  paneKey: string
  tab: TerminalTab
  entry: AgentStatusEntry | undefined
  foreground: PaneForegroundAgentEntry | undefined
  layout: TerminalLayoutSnapshot | undefined
  titles: Record<number, string> | undefined
  livePtyIds: readonly string[]
}): AgentType | null {
  const { foreground, layout } = args
  const pane = parsePaneKey(args.paneKey)
  if (!pane || !isAgentProcessForeground(foreground)) {
    return null
  }
  const ptyId = layout?.ptyIdsByLeafId?.[pane.leafId]
  const live = ptyId
    ? args.livePtyIds.includes(ptyId)
    : layout?.root?.type === 'leaf' &&
      layout.root.leafId === pane.leafId &&
      args.livePtyIds.length > 0
  if (!live) {
    return null
  }
  const paneTitle = resolveAgentRowPaneLiveTitle(layout, args.titles, pane.leafId)
  // An unknown split title must not borrow a sibling's shell title and retire confirmed presence.
  const title =
    paneTitle === null
      ? (args.entry?.terminalTitle ?? formatAgentTypeLabel(foreground.agent))
      : (paneTitle ?? args.tab.title)
  return resolveTitleDerivedPaneAgent({
    title,
    defaultTitle: paneTitle === null ? undefined : args.tab.defaultTitle,
    titleShowsActivity: false,
    titleAgentType: null,
    launchAgentType:
      args.entry?.agentType ??
      (layout?.root?.type === 'leaf' ? (args.tab.launchAgent ?? null) : null),
    foreground
  })
}

/** Presence contributes an Idle snapshot only; it never creates a turn or an unread completion. */
export function appendActivityAgentPresence(context: {
  args: BuildActivityEventsArgs
  cache: ActivityEventBuildCache | undefined
  seenCacheKeys: Set<string> | null
  tabContext: Map<string, ActivityTabContext>
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
  resolveOwner: (tab: ActivityTabContext, entry: AgentStatusEntry) => ActivityEventOwner
}): void {
  const { args, cache, seenCacheKeys, tabContext, liveAgentByPaneKey, resolveOwner } = context
  const statuses = args.agentStatusByPaneKey
  const structuredTabs = args.structuredTabs
    ? structuredTabsByPaneKey(args.structuredTabs)
    : getStructuredAgentSessionTabsByPaneKey(args.unifiedTabsByWorktree)
  // A terminal agent needs process evidence and a chat needs a tab, so no status scan is needed.
  const paneKeys = new Set([
    ...Object.keys(args.paneForegroundAgentByPaneKey ?? {}),
    ...structuredTabs.keys()
  ])
  const presenceKeys = new Set<string>()
  for (const paneKey of paneKeys) {
    // Fresh work/attention and missing-update snapshots keep their existing status authority.
    if (liveAgentByPaneKey[paneKey]) {
      continue
    }
    const structuredTab = structuredTabs.get(paneKey)
    const parsed = parseAgentStatusPaneIdentity(paneKey, structuredTab)
    const tabEntry = parsed ? tabContext.get(parsed.tabId) : undefined
    if (!tabEntry) {
      continue
    }
    // Fresh no-turn host evidence outranks a restored status for the same native session.
    const entry = args.nativeAgentPresenceByPaneKey?.[paneKey] ?? statuses.get(paneKey)
    const foreground = args.paneForegroundAgentByPaneKey?.[paneKey]
    const agentType = structuredTab
      ? entry?.structuredHostOwned && isAgentStatusFresh(entry, args.now)
        ? entry.agentType
        : null
      : terminalPresenceAgent({
          paneKey,
          tab: tabEntry.tab,
          entry,
          foreground,
          layout: args.terminalLayoutsByTabId?.[tabEntry.tab.id],
          titles: args.runtimePaneTitlesByTabId?.[tabEntry.tab.id],
          livePtyIds: args.ptyIdsByTabId?.[tabEntry.tab.id] ?? []
        })
    if (!agentType) {
      continue
    }
    const presenceEntry: AgentStatusEntry = entry
      ? { ...entry, agentType }
      : {
          paneKey,
          state: 'done',
          sessionBoundary: true,
          prompt: '',
          updatedAt: tabEntry.tab.createdAt,
          stateStartedAt: tabEntry.tab.createdAt,
          stateHistory: [],
          agentType,
          tabId: tabEntry.tab.id,
          worktreeId: tabEntry.worktreeId
        }
    const owner = resolveOwner(tabEntry, presenceEntry)
    const cacheKey = `presence:${paneKey}`
    presenceKeys.add(cacheKey)
    const { live } = resolvePaneBuild(
      {
        cacheKey,
        source: entry ?? foreground,
        entry: presenceEntry,
        orchestration: args.runtimeAgentOrchestrationByPaneKey?.[paneKey],
        worktree: owner.worktree,
        repo: owner.repo,
        tab: tabEntry.tab,
        agentType,
        agentAlive: true,
        acknowledgedAt: args.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
        clearedAt: args.activityClearedAtByPaneKey?.[paneKey] ?? 0,
        liveState: 'idle'
      },
      cache,
      seenCacheKeys
    )
    if (live) {
      liveAgentByPaneKey[paneKey] = live
    }
  }
  if (cache) {
    for (const cacheKey of cache.presenceKeys) {
      if (!presenceKeys.has(cacheKey)) {
        cache.panes.delete(cacheKey)
      }
    }
    cache.presenceKeys = presenceKeys
  }
}

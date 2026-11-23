import {
  paneTitleForEntry,
  paneTitleForEvent,
  statusPreviewForEntry
} from './activity-thread-presentation'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveAgentRowPaneLiveTitle } from '../../dashboard/rows/agent-row-pane-live-title'
import type {
  ActivityEvent,
  ActivityLiveAgentSnapshot,
  AgentPaneThread
} from './activity-thread-types'

type PaneThreadInputs = {
  events: readonly ActivityEvent[]
  live: ActivityLiveAgentSnapshot | undefined
  paneEntry: AgentStatusEntry | undefined
  paneLiveTitle: string | null | undefined
}

/** Reuse unchanged thread objects and list identity so memoized rows/search caches survive unrelated store writes. */
export type AgentPaneThreadReuseCache = {
  previousByPaneKey: Map<string, PaneThreadInputs & { thread: AgentPaneThread }>
  previousList: AgentPaneThread[]
  generatedTitlesEnabled?: boolean
  /** Set by a reader of build changes; without one, builds skip the bookkeeping. */
  trackChanges?: boolean
  /** Panes whose thread was added, replaced or dropped by the last build; null when untracked. */
  changedPaneKeys: ReadonlySet<string> | null
}

export function createAgentPaneThreadReuseCache(): AgentPaneThreadReuseCache {
  return { previousByPaneKey: new Map(), previousList: [], changedPaneKeys: null }
}

const NO_EVENTS: readonly ActivityEvent[] = []

function arrayItemsEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

// Upstream preserves event/snapshot identity, making reference equality a valid change detector.
function reuseThreadIfEqual(
  previous: AgentPaneThread | undefined,
  next: AgentPaneThread
): AgentPaneThread {
  if (
    previous !== undefined &&
    previous.paneKey === next.paneKey &&
    previous.paneTitle === next.paneTitle &&
    previous.worktree === next.worktree &&
    previous.repo === next.repo &&
    previous.tab === next.tab &&
    previous.agentType === next.agentType &&
    previous.currentAgentState === next.currentAgentState &&
    previous.currentAgentEntry === next.currentAgentEntry &&
    previous.paneEntry === next.paneEntry &&
    previous.responsePreview === next.responsePreview &&
    previous.latestTimestamp === next.latestTimestamp &&
    previous.latestEvent === next.latestEvent &&
    previous.migrationUnsupportedPtyId === next.migrationUnsupportedPtyId &&
    previous.unread === next.unread &&
    arrayItemsEqual(previous.events, next.events)
  ) {
    return previous
  }
  return next
}

/** One pane's thread from its events (newest first) and live turn. */
function buildPaneThread(
  paneKey: string,
  { events, live, paneEntry, paneLiveTitle }: PaneThreadInputs,
  generatedTitlesEnabled: boolean
): AgentPaneThread {
  let thread: AgentPaneThread | undefined
  for (const event of events) {
    if (!thread) {
      thread = {
        paneKey,
        paneTitle: paneTitleForEvent(event, generatedTitlesEnabled, paneLiveTitle),
        worktree: event.worktree,
        repo: event.repo,
        tab: event.tab,
        agentType: event.agentType,
        currentAgentState: null,
        currentAgentEntry: null,
        paneEntry,
        responsePreview: statusPreviewForEntry(event.entry, event.state),
        latestTimestamp: event.timestamp,
        latestEvent: event,
        events: [event],
        migrationUnsupportedPtyId: event.migrationUnsupportedPtyId,
        unread: event.unread
      }
      continue
    }
    thread.events.push(event)
    thread.unread = thread.unread || event.unread
    thread.migrationUnsupportedPtyId =
      thread.migrationUnsupportedPtyId ?? event.migrationUnsupportedPtyId
    // Why max, not the latest event's: "Clear completed" cuts off at this, and must pass every event.
    thread.latestTimestamp = Math.max(thread.latestTimestamp, event.timestamp)
    if (!thread.latestEvent || event.observedAt > thread.latestEvent.observedAt) {
      thread.latestEvent = event
      thread.paneTitle = paneTitleForEvent(event, generatedTitlesEnabled, paneLiveTitle)
      thread.agentType = event.agentType
      thread.tab = event.tab
      thread.responsePreview = statusPreviewForEntry(
        event.entry,
        event.state,
        thread.responsePreview
      )
    }
  }

  if (live && !thread) {
    thread = {
      paneKey,
      paneTitle: paneTitleForEntry(live.entry, live.tab, generatedTitlesEnabled, paneLiveTitle),
      worktree: live.worktree,
      repo: live.repo,
      tab: live.tab,
      agentType: live.agentType,
      currentAgentState: live.state,
      currentAgentEntry: live.entry,
      paneEntry,
      responsePreview: statusPreviewForEntry(live.entry, live.entry.state),
      latestTimestamp: live.timestamp,
      latestEvent: null,
      events: [],
      migrationUnsupportedPtyId: live.migrationUnsupportedPtyId,
      unread: false
    }
  } else if (live && thread) {
    // Why: row title/time/target must follow the active turn (not historical events) so a running agent never shows the previous prompt as primary.
    thread.paneTitle = paneTitleForEntry(
      live.entry,
      live.tab,
      generatedTitlesEnabled,
      paneLiveTitle
    )
    thread.worktree = live.worktree
    thread.repo = live.repo
    thread.tab = live.tab
    thread.agentType = live.agentType
    thread.currentAgentState = live.state
    thread.currentAgentEntry = live.entry
    thread.migrationUnsupportedPtyId ??= live.migrationUnsupportedPtyId
    thread.responsePreview = statusPreviewForEntry(
      live.entry,
      live.entry.state,
      thread.responsePreview
    )
    // Idle presence is not a new turn; Clear must still cover every later historical event.
    thread.latestTimestamp =
      live.state === 'idle' ? Math.max(thread.latestTimestamp, live.timestamp) : live.timestamp
  }
  // Every listed pane has an event or a live turn.
  const built = thread!
  return { ...built, events: [...built.events].sort((a, b) => b.observedAt - a.observedAt) }
}

export function buildAgentPaneThreads(
  args: {
    events: ActivityEvent[]
    liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
    paneEntryByPaneKey?: Record<string, AgentStatusEntry>
    generatedTitlesEnabled?: boolean
    terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
    runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  },
  reuseCache?: AgentPaneThreadReuseCache
): AgentPaneThread[] {
  const generatedTitlesEnabled = args.generatedTitlesEnabled === true
  // Why: in a split tab, tab.title belongs to the focused pane, so each row reads its own pane's title.
  const paneLiveTitleFor = (paneKey: string): string | null | undefined => {
    const separator = paneKey.indexOf(':')
    const tabId = separator > 0 ? paneKey.slice(0, separator) : ''
    return resolveAgentRowPaneLiveTitle(
      args.terminalLayoutsByTabId?.[tabId],
      args.runtimePaneTitlesByTabId?.[tabId],
      parsePaneKey(paneKey)?.leafId
    )
  }
  // Panes list in first-event order, then live-only panes in live order.
  const eventsByPaneKey = new Map<string, ActivityEvent[]>()
  for (const event of args.events) {
    const paneEvents = eventsByPaneKey.get(event.entry.paneKey)
    if (paneEvents) {
      paneEvents.push(event)
    } else {
      eventsByPaneKey.set(event.entry.paneKey, [event])
    }
  }
  const paneKeys = Array.from(eventsByPaneKey.keys())
  for (const paneKey of Object.keys(args.liveAgentByPaneKey)) {
    if (!eventsByPaneKey.has(paneKey)) {
      paneKeys.push(paneKey)
    }
  }

  // A thread depends only on its pane's inputs, so unchanged panes keep their thread without rebuilding it.
  const reusable = reuseCache?.generatedTitlesEnabled === generatedTitlesEnabled
  const nextByPaneKey = new Map<string, PaneThreadInputs & { thread: AgentPaneThread }>()
  const changedPaneKeys = reuseCache?.trackChanges ? new Set<string>() : null
  let keptPaneCount = 0
  const built = paneKeys
    .map((paneKey) => {
      const inputs: PaneThreadInputs = {
        events: eventsByPaneKey.get(paneKey) ?? NO_EVENTS,
        live: Object.hasOwn(args.liveAgentByPaneKey, paneKey)
          ? args.liveAgentByPaneKey[paneKey]
          : undefined,
        paneEntry: args.paneEntryByPaneKey?.[paneKey],
        paneLiveTitle: paneLiveTitleFor(paneKey)
      }
      const previous = reuseCache?.previousByPaneKey.get(paneKey)
      const thread =
        reusable &&
        previous !== undefined &&
        previous.live === inputs.live &&
        previous.paneEntry === inputs.paneEntry &&
        previous.paneLiveTitle === inputs.paneLiveTitle &&
        arrayItemsEqual(previous.events, inputs.events)
          ? previous.thread
          : reuseThreadIfEqual(
              previous?.thread,
              buildPaneThread(paneKey, inputs, generatedTitlesEnabled)
            )
      nextByPaneKey.set(paneKey, { ...inputs, thread })
      if (changedPaneKeys) {
        keptPaneCount += Number(previous !== undefined)
        if (previous?.thread !== thread) {
          changedPaneKeys.add(paneKey)
        }
      }
      return thread
    })
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp)

  if (!reuseCache) {
    return built
  }
  const result = arrayItemsEqual(reuseCache.previousList, built) ? reuseCache.previousList : built
  if (changedPaneKeys && keptPaneCount < reuseCache.previousByPaneKey.size) {
    for (const paneKey of reuseCache.previousByPaneKey.keys()) {
      if (!nextByPaneKey.has(paneKey)) {
        changedPaneKeys.add(paneKey)
      }
    }
  }
  reuseCache.changedPaneKeys = changedPaneKeys
  reuseCache.previousList = result
  reuseCache.previousByPaneKey = nextByPaneKey
  reuseCache.generatedTitlesEnabled = generatedTitlesEnabled
  return result
}

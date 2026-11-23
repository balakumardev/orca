import { shallow } from 'zustand/shallow'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { getStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

export type NativeAgentPresence = Readonly<Record<string, AgentStatusEntry>>

export const NO_NATIVE_AGENT_PRESENCE: NativeAgentPresence = {}

type NativeAgentPresenceObserver = {
  names: StructuredChatTabNames
  getSnapshot: () => NativeAgentPresence
  subscribe: (listener: () => void) => () => void
}

/** The normal status bridge omits no-turn chats; only a live host-owned session proves their presence. */
function observeNativeAgentPresence(names: StructuredChatTabNames): NativeAgentPresenceObserver {
  const members = [...names].flatMap(([tab, name]) => {
    const target = structuredAgentSessionTargetForHost(name.owner)
    return target ? [{ tab, feed: getStructuredAgentSessionStatusFeed(target) }] : []
  })
  const sources = new Map<string, AgentSessionStatusSummary>()
  let snapshot = NO_NATIVE_AGENT_PRESENCE
  const getSnapshot = (): NativeAgentPresence => {
    const next: Record<string, AgentStatusEntry> = {}
    for (const { tab, feed } of members) {
      const summary = feed.getSnapshot().get(tab.entityId)
      if (
        summary?.status !== null ||
        summary.hostExecutionOwned !== true ||
        feed.getSessionObservation(tab.entityId) !== 'live'
      ) {
        continue
      }
      const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
      const previous = snapshot[paneKey]
      next[paneKey] =
        previous && sources.get(paneKey) === summary
          ? previous
          : {
              paneKey,
              state: 'done',
              sessionBoundary: true,
              structuredHostOwned: true,
              agentType: summary.agent,
              prompt: '',
              stateHistory: [],
              updatedAt: summary.updatedAt,
              stateStartedAt: summary.updatedAt,
              tabId: tab.id,
              worktreeId: tab.worktreeId
            }
      sources.set(paneKey, summary)
    }
    if (!shallow(snapshot, next)) {
      snapshot = next
    }
    return snapshot
  }
  const subscribe = (listener: () => void): (() => void) => {
    const stops = [...new Set(members.map(({ feed }) => feed))].map((feed) => {
      const stop = feed.subscribe(listener)
      const release = feed.activate()
      return () => {
        stop()
        release()
      }
    })
    return () => stops.forEach((stop) => stop())
  }
  return { names, getSnapshot, subscribe }
}

let observer: NativeAgentPresenceObserver | null = null
let stopObserving: (() => void) | null = null
let changed: (() => void) | null = null

// The observer follows the chat names it was built for; a rename or tab change retargets it on the next read.
function observerFor(names: StructuredChatTabNames): NativeAgentPresenceObserver {
  if (observer?.names !== names) {
    stopObserving?.()
    stopObserving = null
    observer = observeNativeAgentPresence(names)
  }
  if (changed && stopObserving === null) {
    stopObserving = observer.subscribe(changed)
  }
  return observer
}

/** Live host-owned chats before their first turn; stable until a status feed changes what it shows. */
export function readNativeAgentPresence(): NativeAgentPresence {
  return observerFor(getStructuredChatTabNames()).getSnapshot()
}

/** Shares the existing local/paired status streams while Activity is observed; a disconnect revokes presence without inventing a completion. */
export function observeNativeAgentPresenceChanges(notify: () => void): () => void {
  changed = notify
  observerFor(getStructuredChatTabNames())
  return () => {
    changed = null
    stopObserving?.()
    stopObserving = null
    observer = null
  }
}

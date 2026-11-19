import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { useAppViewExternalStore } from '@/store/retained-views/app-state-view'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

/** The normal status bridge omits no-turn chats; only a live host-owned session proves their presence. */
function observeNativeAgentPresence(names: StructuredChatTabNames) {
  const members = [...names].flatMap(([tab, name]) => {
    const target = structuredAgentSessionTargetForHost(name.owner)
    return target ? [{ tab, feed: getStructuredAgentSessionStatusFeed(target) }] : []
  })
  const sources = new Map<string, AgentSessionStatusSummary>()
  let snapshot: Readonly<Record<string, AgentStatusEntry>> = {}
  const getSnapshot = (): Readonly<Record<string, AgentStatusEntry>> => {
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
  return { getSnapshot, subscribe }
}

/** Share the existing local/paired status streams; disconnect revokes presence without inventing completion. */
export function useActivityNativeAgentPresence(
  names: StructuredChatTabNames
): Readonly<Record<string, AgentStatusEntry>> {
  const observer = useMemo(() => observeNativeAgentPresence(names), [names])
  return useAppViewExternalStore(observer.subscribe, observer.getSnapshot, observer.getSnapshot)
}

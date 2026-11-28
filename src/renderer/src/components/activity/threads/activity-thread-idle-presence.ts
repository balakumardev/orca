import { agentVerdictDisplayMark } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import type { AgentPaneThread } from './activity-thread-types'

/** An idle process is separate from its previous verdict; only a live turn's failed main agent outranks subagent work. */
export function isFailedLiveMainAgent(thread: AgentPaneThread): boolean {
  const entry = thread.currentAgentEntry
  return (
    thread.currentAgentState !== 'idle' &&
    entry !== null &&
    agentVerdictDisplayMark(entry) === 'failed'
  )
}

/** Idle presence must not hide a finished turn nobody has read yet; once it is read, the thread reads Idle. */
function idlePresenceYieldsToUnreadFinish(thread: AgentPaneThread): boolean {
  return thread.currentAgentState === 'idle' && thread.paneEntry?.state === 'done' && thread.unread
}

/** The live state the row shows: any live state, except idle presence over an unread finished turn. */
export function threadShowsLiveState(thread: AgentPaneThread): boolean {
  return Boolean(thread.currentAgentState) && !idlePresenceYieldsToUnreadFinish(thread)
}

/** Process presence cannot answer an outstanding input request. */
export function outstandingInputState(thread: AgentPaneThread): 'blocked' | 'waiting' | null {
  const state = thread.currentAgentEntry?.state
  return thread.currentAgentState === 'idle' && (state === 'blocked' || state === 'waiting')
    ? state
    : null
}

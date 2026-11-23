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

/** Process presence cannot answer an outstanding input request. */
export function outstandingInputState(thread: AgentPaneThread): 'blocked' | 'waiting' | null {
  const state = thread.currentAgentEntry?.state
  return thread.currentAgentState === 'idle' && (state === 'blocked' || state === 'waiting')
    ? state
    : null
}

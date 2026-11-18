import type { AppState } from '@/store/types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  adoptsCliConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { nativeChatPreferenceFor } from '../../../../shared/structured-native-chat-launch-route'
import {
  canJumpToAiVaultSessionWorktree,
  resolveAiVaultSessionWorktreeInfo
} from '../../../../shared/ai-vault/session-display/ai-vault-session-worktree'
import { selectAgentLaunchRouteView } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { findOriginalAiVaultSessionPane } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-original-pane'
import { resolveAiVaultSessionRowChatActions } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-chat-action'
import { resolveAiVaultHistoryRowResume } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-workspace'
import {
  aiVaultSearchHitToSession,
  canResumeAiVaultSearchHit
} from '@/components/right-sidebar/ai-vault/search/ai-vault-search-session'
import { aiVaultSessionOwnerWorkspaces } from '@/components/right-sidebar/ai-vault/session-list/ai-vault-session-worktree'
import type { PaletteSessionFacts } from './palette-session-action'

/** The hit as the Agent Session History panel models it, so the panel's own resolvers can answer for it. */
export function paletteSessionOfHit(hit: AiVaultSearchHit) {
  return aiVaultSearchHitToSession(hit, LOCAL_EXECUTION_HOST_ID)
}

/** Agents whose chat could take a conversation of `agent` over: an OpenCode chat can take an OpenCode 2 one. */
function chatAgentsThatCouldTakeOver(agent: string): readonly string[] {
  return adoptsCliConversations(agent) ? CLI_CONVERSATION_ADOPTING_AGENTS[agent] : [agent]
}

/**
 * Everything Enter on a hit depends on, read from the store as it is now. The workspace is found from the
 * transcript's own folder with no fallback to the open workspace, so resuming never lands in a repo the
 * conversation was not started in.
 */
export function readPaletteSessionFacts(
  state: AppState,
  hit: AiVaultSearchHit
): PaletteSessionFacts {
  const session = paletteSessionOfHit(hit)
  const worktrees = aiVaultSessionOwnerWorkspaces(
    getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    selectFolderWorkspaces(state)
  )
  const worktreeInfo = resolveAiVaultSessionWorktreeInfo({
    session,
    repos: state.repos,
    worktrees,
    activeWorktreeId: null
  })
  const { resumeState, resumeInChat } = resolveAiVaultHistoryRowResume({
    session,
    worktreeInfo,
    activeWorktreeId: null,
    worktrees,
    repos: state.repos,
    targetState: state,
    settings: selectAgentLaunchRouteView(state).settings
  })
  const originalPane = findOriginalAiVaultSessionPane(state, session)
  return {
    nativeChat: hit.structuredSession !== undefined,
    originalPane,
    resumable: canResumeAiVaultSearchHit(hit),
    ownerWorkspaceId: canJumpToAiVaultSessionWorktree(worktreeInfo)
      ? (worktreeInfo?.worktreeId ?? null)
      : null,
    // A chat keeps what it takes over, so one CLI choice among the chats that could take it keeps it in a terminal.
    opensAsChat: chatAgentsThatCouldTakeOver(session.agent).every((agent) =>
      nativeChatPreferenceFor(state.settings, agent)
    ),
    // The panel's own target for its resume button; only a native chat transcript has a chat that can be open.
    terminalResumeWorkspaceId: resolveAiVaultSessionRowChatActions({
      session,
      originalPaneTarget: originalPane,
      structuredSessionOpen: false,
      resumeState,
      resumeInChat,
      searchHit: hit
    }).resumeWorktreeId,
    chatResume: resumeInChat
  }
}

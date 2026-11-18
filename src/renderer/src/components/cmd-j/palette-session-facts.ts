import type { AppState } from '@/store/types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
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
  const { resumeInChat } = resolveAiVaultHistoryRowResume({
    session,
    worktreeInfo,
    activeWorktreeId: null,
    worktrees,
    repos: state.repos,
    targetState: state,
    settings: selectAgentLaunchRouteView(state).settings
  })
  return {
    nativeChat: hit.structuredSession !== undefined,
    originalPane: findOriginalAiVaultSessionPane(state, session),
    resumable: canResumeAiVaultSearchHit(hit),
    ownerWorkspaceId: canJumpToAiVaultSessionWorktree(worktreeInfo)
      ? (worktreeInfo?.worktreeId ?? null)
      : null,
    chatResume: resumeInChat
  }
}

import { useAppStore } from '@/store/index'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { formatWorkspaceCreateError } from './workspace-create-error-format'

export function worktreeCreationChatTargetError(request: WorktreeCreationRequest): string | null {
  try {
    request.targetGuard?.assertCurrent(request.executionHostId)
    return null
  } catch (error) {
    return formatWorkspaceCreateError(error).message
  }
}

/** Keep pending input owned by its original computer while admission and the composer handoff wait. */
export function watchCreationChatHost(
  creationId: string,
  request: WorktreeCreationRequest,
  abandoned: AbortController,
  revealAbandoned: AbortController
): () => void {
  return useAppStore.subscribe((state) => {
    if (state.activeView !== 'terminal' || state.activePendingCreationId !== creationId) {
      revealAbandoned.abort()
    }
    if (
      !state.pendingWorktreeCreations[creationId] ||
      worktreeCreationChatTargetError(request) !== null
    ) {
      abandoned.abort()
      revealAbandoned.abort()
    }
  })
}

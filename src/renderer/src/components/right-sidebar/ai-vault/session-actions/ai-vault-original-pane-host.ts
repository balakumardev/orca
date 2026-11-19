import type { AppState } from '@/store/types'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/workspace/ownership/worktree-operation-route'
import { authorityKey } from '../../../../../../shared/host-authority'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export type AiVaultPaneHostState = WorktreeOperationRouteState &
  Partial<Pick<AppState, 'unifiedTabsByWorktree'>>

/** A pane's published owner outranks workspace IDs that another computer may also use. */
export function aiVaultPaneBelongsToHost(
  state: AiVaultPaneHostState,
  worktreeId: string,
  tabId: string,
  hostId: ExecutionHostId
): boolean {
  const tabHosts = new Set(
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).flatMap((tab) =>
      (tab.entityId === tabId || tab.id === tabId) && tab.executionHostId
        ? [tab.executionHostId]
        : []
    )
  )
  if (tabHosts.size > 0) {
    return tabHosts.size === 1 && tabHosts.has(hostId)
  }
  const owner = resolveOwner(
    { ...state, activeWorktreeId: null, activeWorkspaceExecutionHostId: null },
    { workspaceId: worktreeId }
  )
  return owner.kind === 'resolved'
    ? authorityKey(owner.owner) === hostId
    : owner.kind === 'missing' && hostId === 'local'
}

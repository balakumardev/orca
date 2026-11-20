import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { composeWorktreeId } from '../../shared/worktree/id'
import { getLocalRepoForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import type { RuntimeGitTarget } from '../runtime/integrations/git/runtime-git-command-target'

/** Commit and PR text for a runtime target: the workspace whose project pin picks the account. */
export function generationWorkspaceOfRuntimeTarget(target: RuntimeGitTarget): {
  workspaceId?: string
} {
  return target.executionHostId === LOCAL_EXECUTION_HOST_ID
    ? { workspaceId: target.worktree.id }
    : {}
}

/** The same for a renderer request: the local project that owns the path, not the ids it sent. */
export function generationWorkspaceOfLocalPath(
  store: RuntimeStore,
  worktreePath: string,
  resolvedWorktreePath: string
): string | undefined {
  const repo = getLocalRepoForRegisteredWorktree(store, worktreePath, resolvedWorktreePath)
  return repo ? composeWorktreeId(repo.id, resolvedWorktreePath) : undefined
}

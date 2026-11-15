import { PROJECT_CREATE_SOURCE_ID } from '@/components/cmd-j/palette-project-create-source-id'
import { getPaletteWorktreeExecutionHostId } from '@/lib/workspace/search/palette-repo-resolution'
import { getNewWorkspaceDialogEligibleRepos } from '../../../../shared/new-workspace-dialog-repo'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { PaletteListEntry } from './worktree-jump-palette-model'

function getEntryRepoId(
  entry: PaletteListEntry | undefined,
  workspaces: readonly Worktree[]
): string | null {
  if (entry?.type === 'worktree') {
    return entry.worktree.repoId
  }
  if (entry?.type === 'project-target') {
    return entry.result.kind === 'project' ? entry.result.repo.id : null
  }
  if (entry?.type === 'workspace-tab') {
    // A tab names its workspace by id and host; a spelling of the host that differs (local, unqualified) still
    // finds the workspace when its id is unique.
    const sameId = workspaces.filter((worktree) => worktree.id === entry.result.worktreeId)
    const sameHost = sameId.find(
      (worktree) => getPaletteWorktreeExecutionHostId(worktree) === entry.result.executionHostId
    )
    return (sameHost ?? (sameId.length === 1 ? sameId[0] : undefined))?.repoId ?? null
  }
  if (entry?.type === 'extra') {
    return entry.sourceId === PROJECT_CREATE_SOURCE_ID ? entry.result.id : null
  }
  return null
}

/** The id when it names a git project the new-workspace composer can target, else null. */
export function getUsableGitProjectRepoId(
  repoId: string | null,
  repos: readonly Repo[]
): string | null {
  const usable = repos.some(
    (repo) =>
      repo.id === repoId &&
      isGitRepoKind(repo) &&
      getNewWorkspaceDialogEligibleRepos([repo]).length > 0
  )
  return usable ? repoId : null
}

/** The git project a palette row belongs to, when a worktree can be started in it. */
export function getPaletteEntryProjectRepoId(
  entry: PaletteListEntry | undefined,
  context: { workspaces: readonly Worktree[]; repos: readonly Repo[] }
): string | null {
  return getUsableGitProjectRepoId(getEntryRepoId(entry, context.workspaces), context.repos)
}

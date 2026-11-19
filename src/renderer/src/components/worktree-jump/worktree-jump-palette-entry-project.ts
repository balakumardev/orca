import { PROJECT_CREATE_SOURCE_ID } from '@/components/cmd-j/palette-project-create-source-id'
import { getPaletteWorktreeExecutionHostId } from '@/lib/workspace/search/palette-repo-resolution'
import { getUsableGitProjectRepo } from '@/components/cmd-j/palette-project-create-targets'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { PaletteListEntry } from './worktree-jump-palette-model'

/** The exact git checkout a palette row belongs to; host mismatches never use a sole local copy. */
export function getPaletteEntryProjectRepo(
  entry: PaletteListEntry | undefined,
  { workspaces, repos }: { workspaces: readonly Worktree[]; repos: readonly Repo[] }
): Repo | null {
  if (entry?.type === 'worktree') {
    return getUsableGitProjectRepo(
      entry.worktree.repoId,
      repos,
      getPaletteWorktreeExecutionHostId(entry.worktree) ?? LOCAL_EXECUTION_HOST_ID
    )
  }
  if (entry?.type === 'project-target') {
    return entry.result.kind === 'project'
      ? getUsableGitProjectRepo(
          entry.result.repo.id,
          repos,
          getRepoExecutionHostId(entry.result.repo)
        )
      : null
  }
  if (entry?.type === 'workspace-tab') {
    // Runtime ownership outranks the physical host in the workspace snapshot.
    const sameId = workspaces.filter((worktree) => worktree.id === entry.result.worktreeId)
    const workspace = entry.result.executionHostId
      ? sameId.find(
          (worktree) =>
            (getPaletteWorktreeExecutionHostId(worktree) ?? LOCAL_EXECUTION_HOST_ID) ===
            entry.result.executionHostId
        )
      : sameId.length === 1
        ? sameId[0]
        : undefined
    return workspace
      ? getUsableGitProjectRepo(
          workspace.repoId,
          repos,
          getPaletteWorktreeExecutionHostId(workspace) ?? LOCAL_EXECUTION_HOST_ID
        )
      : null
  }
  if (entry?.type === 'extra' && entry.sourceId === PROJECT_CREATE_SOURCE_ID) {
    const target = entry.result.projectCreateTarget
    return getUsableGitProjectRepo(
      target?.repoId ?? entry.result.id,
      repos,
      target?.workspaceTarget.hostId
    )
  }
  return null
}

/** The git project a palette row belongs to, when a worktree can be started in it. */
export function getPaletteEntryProjectRepoId(
  entry: PaletteListEntry | undefined,
  context: { workspaces: readonly Worktree[]; repos: readonly Repo[] }
): string | null {
  return getPaletteEntryProjectRepo(entry, context)?.id ?? null
}

/**
 * The project Cmd/Ctrl+Enter starts a worktree in for this row. A pasted issue or PR link owns the palette, and a
 * row beside it must not swallow the link, so there is none then.
 */
export function getPaletteEntryNewWorktreeRepoId(
  entry: PaletteListEntry | undefined,
  context: {
    workspaces: readonly Worktree[]
    repos: readonly Repo[]
    taskSourceUrl: object | null
  }
): string | null {
  return context.taskSourceUrl ? null : getPaletteEntryProjectRepoId(entry, context)
}

/** What Cmd/Ctrl+Enter does on a Folders row that adds its project first; none while a pasted link owns the palette. */
export function getPaletteEntryFolderNewWorktree(
  entry: PaletteListEntry | undefined,
  taskSourceUrl: object | null
): (() => void) | null {
  return !taskSourceUrl && entry?.type === 'extra' ? (entry.result.onModEnter ?? null) : null
}

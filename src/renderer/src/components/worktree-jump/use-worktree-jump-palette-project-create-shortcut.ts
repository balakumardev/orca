import { useCallback, useMemo } from 'react'
import type React from 'react'
import { getProjectCreateLabel } from '@/components/cmd-j/palette-project-create-targets'
import { beginProjectNameStep } from '@/components/cmd-j/palette-project-name-step-store'
import { usePaletteProjectCatalog } from '@/components/cmd-j/use-palette-project-catalog'
import { isPaletteCurrentWorktree } from '@/lib/workspace/search/palette-repo-resolution'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  getPaletteEntryProjectRepoId,
  getUsableGitProjectRepoId
} from './worktree-jump-palette-entry-project'

type ProjectCreateShortcutInput = Pick<
  WorktreeJumpPaletteController,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'commandSelectedItemId'
  | 'hasQuery'
  | 'listEntries'
  | 'listEntryRenderKeys'
  | 'liveQueryRef'
  | 'paletteSearchQuery'
  | 'repos'
  | 'taskSourceUrl'
  | 'workspaces'
>

/**
 * Cmd/Ctrl+Enter on a highlighted row that belongs to a git project, and Cmd/Ctrl+Shift+Enter anywhere in a
 * git project's workspace, start the palette's name step for that project. Neither creates anything.
 */
export function useWorktreeJumpPaletteProjectCreateShortcut({
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  commandSelectedItemId,
  hasQuery,
  listEntries,
  listEntryRenderKeys,
  liveQueryRef,
  paletteSearchQuery,
  repos,
  taskSourceUrl,
  workspaces
}: ProjectCreateShortcutInput): {
  /** Set only while the highlighted row has a project a worktree can be started in. */
  projectRepoId: string | null
  /** Set while the workspace you are in belongs to such a project. */
  currentProjectRepoId: string | null
  /** The palette's name for those two projects, for the footer hints. */
  projectLabel: string | null
  currentProjectLabel: string | null
  /** What the footer names for the chord on the highlighted row, and for the chord on the workspace you are in. */
  rowHintLabel: string | null
  currentHintLabel: string | null
  /** True when the key was one of the shortcuts and was handled. */
  handleKeyDown: (event: React.KeyboardEvent) => boolean
} {
  const catalog = usePaletteProjectCatalog()
  // A pasted issue or PR link has its own Create row; a row beside it must not swallow the link.
  const projectRepoId = useMemo(
    () =>
      taskSourceUrl
        ? null
        : getPaletteEntryProjectRepoId(
            listEntries[listEntryRenderKeys.indexOf(commandSelectedItemId)],
            { workspaces, repos }
          ),
    [commandSelectedItemId, listEntries, listEntryRenderKeys, repos, taskSourceUrl, workspaces]
  )
  const currentProjectRepoId = useMemo(() => {
    const current = workspaces.find((workspace) =>
      isPaletteCurrentWorktree(workspace, activeWorktreeId, activeWorkspaceExecutionHostId)
    )
    return taskSourceUrl ? null : getUsableGitProjectRepoId(current?.repoId ?? null, repos)
  }, [activeWorkspaceExecutionHostId, activeWorktreeId, repos, taskSourceUrl, workspaces])
  const labelOf = useCallback(
    (repoId: string | null): string | null => {
      const repo = repos.find((candidate) => candidate.id === repoId)
      return repo ? getProjectCreateLabel(repo, catalog) : null
    },
    [catalog, repos]
  )
  const projectLabel = useMemo(() => labelOf(projectRepoId), [labelOf, projectRepoId])
  const currentProjectLabel = useMemo(
    () => labelOf(currentProjectRepoId),
    [currentProjectRepoId, labelOf]
  )
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      const modifierHeld = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      const repoId = event.shiftKey ? currentProjectRepoId : projectRepoId
      if (
        !repoId ||
        event.key !== 'Enter' ||
        !modifierHeld ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229
      ) {
        return false
      }
      event.preventDefault()
      event.stopPropagation()
      // Until the list catches up with the input, the highlighted row belongs to an earlier query.
      const staleRow = !event.shiftKey && liveQueryRef.current.trim() !== paletteSearchQuery
      if (event.repeat || staleRow) {
        return true
      }
      beginProjectNameStep({
        repoId,
        projectLabel: (event.shiftKey ? currentProjectLabel : projectLabel) ?? ''
      })
      return true
    },
    [
      currentProjectLabel,
      currentProjectRepoId,
      liveQueryRef,
      paletteSearchQuery,
      projectLabel,
      projectRepoId
    ]
  )
  // With an empty search no row is the target; the current project is not named twice for the same project.
  const rowHintLabel = hasQuery ? projectLabel : null
  const currentHintLabel =
    currentProjectRepoId !== projectRepoId || !hasQuery ? currentProjectLabel : null
  return {
    projectRepoId,
    currentProjectRepoId,
    projectLabel,
    currentProjectLabel,
    rowHintLabel,
    currentHintLabel,
    handleKeyDown
  }
}

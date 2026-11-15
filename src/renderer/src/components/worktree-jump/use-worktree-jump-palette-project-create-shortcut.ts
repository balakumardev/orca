import { useCallback, useMemo } from 'react'
import type React from 'react'
import { getProjectCreateLabel } from '@/components/cmd-j/palette-project-create-targets'
import { beginProjectNameStep } from '@/components/cmd-j/palette-project-name-step-store'
import { usePaletteProjectCatalog } from '@/components/cmd-j/use-palette-project-catalog'
import { isPaletteCurrentWorktree } from '@/lib/workspace/search/palette-repo-resolution'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  getPaletteEntryFolderNewWorktree,
  getPaletteEntryNewWorktreeRepoId,
  getUsableGitProjectRepoId
} from './worktree-jump-palette-entry-project'

type ProjectCreateShortcutInput = Pick<
  WorktreeJumpPaletteController,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'commandSelectedItemId'
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
 * git project's workspace, start the palette's name step for that project. Neither creates anything. On a Folders
 * row that is an untracked git root, Cmd/Ctrl+Enter adds the project first and then starts the step.
 */
export function useWorktreeJumpPaletteProjectCreateShortcut({
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  commandSelectedItemId,
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
  /** Set while the highlighted row is a Folders row whose project Cmd/Ctrl+Enter adds first. */
  folderAddsProject: boolean
  /** True when the key was one of the shortcuts and was handled. */
  handleKeyDown: (event: React.KeyboardEvent) => boolean
} {
  const catalog = usePaletteProjectCatalog()
  const highlighted = listEntries[listEntryRenderKeys.indexOf(commandSelectedItemId)]
  const projectRepoId = useMemo(
    () => getPaletteEntryNewWorktreeRepoId(highlighted, { workspaces, repos, taskSourceUrl }),
    [highlighted, repos, taskSourceUrl, workspaces]
  )
  const folderNewWorktree = useMemo(
    () => getPaletteEntryFolderNewWorktree(highlighted, taskSourceUrl),
    [highlighted, taskSourceUrl]
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
      const addFolder = event.shiftKey || repoId ? null : folderNewWorktree
      if (
        (!repoId && !addFolder) ||
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
      if (!repoId) {
        // A Folders row: the project is added, then the name step starts for it.
        addFolder?.()
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
      folderNewWorktree,
      liveQueryRef,
      paletteSearchQuery,
      projectLabel,
      projectRepoId
    ]
  )
  // The highlighted row is the target with or without a query; the current project is not named twice for the same project.
  const rowHintLabel = projectLabel
  const currentHintLabel = currentProjectRepoId !== projectRepoId ? currentProjectLabel : null
  return {
    projectRepoId,
    currentProjectRepoId,
    projectLabel,
    currentProjectLabel,
    rowHintLabel,
    currentHintLabel,
    folderAddsProject: folderNewWorktree !== null,
    handleKeyDown
  }
}

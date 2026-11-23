import { useCallback, useMemo } from 'react'
import type React from 'react'
import {
  getProjectCreateLabel,
  getUsableGitProjectRepo
} from '@/components/cmd-j/palette-project-create-targets'
import { beginProjectNameStep } from '@/components/cmd-j/palette-project-name-step-store'
import { usePaletteProjectCatalog } from '@/components/cmd-j/use-palette-project-catalog'
import { usePaletteSearchHosts } from '@/components/cmd-j/use-palette-search-hosts'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import { getPaletteWorktreeExecutionHostId } from '@/lib/workspace/search/palette-repo-resolution'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  getPaletteEntryFolderNewWorktree,
  getPaletteEntryProjectRepo
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
  const projectRepo = useMemo(
    () => (taskSourceUrl ? null : getPaletteEntryProjectRepo(highlighted, { workspaces, repos })),
    [highlighted, repos, taskSourceUrl, workspaces]
  )
  const folderNewWorktree = useMemo(
    () => getPaletteEntryFolderNewWorktree(highlighted, taskSourceUrl),
    [highlighted, taskSourceUrl]
  )
  const currentProjectRepo = useMemo(() => {
    // A server's physical local host is not an alias for this computer when choosing a create target.
    const current = workspaces.find(
      (workspace) =>
        workspace.id === activeWorktreeId &&
        (getPaletteWorktreeExecutionHostId(workspace) ?? LOCAL_EXECUTION_HOST_ID) ===
          (activeWorkspaceExecutionHostId ?? LOCAL_EXECUTION_HOST_ID)
    )
    return taskSourceUrl || !current
      ? null
      : getUsableGitProjectRepo(
          current.repoId,
          repos,
          getPaletteWorktreeExecutionHostId(current) ?? LOCAL_EXECUTION_HOST_ID
        )
  }, [activeWorkspaceExecutionHostId, activeWorktreeId, repos, taskSourceUrl, workspaces])
  // Saved shortcut callbacks retain each exact pairing, even when both ids alias the same server.
  const projectHosts = usePaletteSearchHosts(
    projectRepo ? [getRepoExecutionHostId(projectRepo)] : []
  )
  const currentProjectHosts = usePaletteSearchHosts(
    currentProjectRepo ? [getRepoExecutionHostId(currentProjectRepo)] : []
  )
  const labelOf = useCallback(
    (repo: Repo | null): string | null => (repo ? getProjectCreateLabel(repo, catalog) : null),
    [catalog]
  )
  const projectLabel = useMemo(() => labelOf(projectRepo), [labelOf, projectRepo])
  const currentProjectLabel = useMemo(
    () => labelOf(currentProjectRepo),
    [currentProjectRepo, labelOf]
  )
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      const modifierHeld = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      const repo = event.shiftKey ? currentProjectRepo : projectRepo
      const addFolder = event.shiftKey || repo ? null : folderNewWorktree
      if (
        (!repo && !addFolder) ||
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
      if (!repo) {
        // A Folders row: the project is added, then the name step starts for it.
        addFolder?.()
        return true
      }
      // The create row already owns a captured authority; a refreshed shortcut must not replace it.
      if (
        !event.shiftKey &&
        highlighted?.type === 'extra' &&
        highlighted.result.projectCreateTarget
      ) {
        highlighted.result.onSelect()
        return true
      }
      // Keep the row's captured setup, rather than deriving another target from its bare repo id.
      const rowTarget =
        highlighted?.type === 'project-target' && highlighted.result.kind === 'project'
          ? highlighted.result.workspaceTarget
          : undefined
      const workspaceTarget =
        (!event.shiftKey && rowTarget) ||
        getRepoWorkspaceCreationTargetHint(repo, catalog.projectHostSetups)
      beginProjectNameStep({
        repoId: repo.id,
        projectLabel: (event.shiftKey ? currentProjectLabel : projectLabel) ?? '',
        workspaceTarget,
        host:
          (event.shiftKey ? currentProjectHosts : projectHosts).find(
            (host) => host.executionHostId === workspaceTarget.hostId
          ) ?? null
      })
      return true
    },
    [
      currentProjectLabel,
      currentProjectRepo,
      currentProjectHosts,
      catalog.projectHostSetups,
      folderNewWorktree,
      liveQueryRef,
      paletteSearchQuery,
      highlighted,
      projectLabel,
      projectRepo,
      projectHosts
    ]
  )
  // The highlighted row is the target with or without a query; the current project is not named twice for the same project.
  const rowHintLabel = projectLabel
  const currentHintLabel = currentProjectRepo !== projectRepo ? currentProjectLabel : null
  return {
    projectRepoId: projectRepo?.id ?? null,
    currentProjectRepoId: currentProjectRepo?.id ?? null,
    projectLabel,
    currentProjectLabel,
    rowHintLabel,
    currentHintLabel,
    folderAddsProject: folderNewWorktree !== null,
    handleKeyDown
  }
}

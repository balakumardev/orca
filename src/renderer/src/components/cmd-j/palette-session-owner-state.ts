import type { AppState } from '@/store/types'
import { getPaletteWorktreeExecutionHostId } from '@/lib/workspace/search/palette-repo-resolution'
import { readAgentLaunchPreferencesForWorkspace } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { normalizeDisabledTuiAgents } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'
import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'

/** Bare workspace lookups see only the recording host's rows, never a same-ID copy elsewhere. */
export function paletteSessionOwnerState(state: AppState, hostId: ExecutionHostId): AppState {
  const onHost = (row: Parameters<typeof getRepoExecutionHostId>[0]) =>
    getRepoExecutionHostId(row) === hostId
  const worktreesByRepo = Object.fromEntries(
    Object.entries(selectWorktreesByRepo(state)).map(([id, rows]) => [
      id,
      rows.filter((row) => (getPaletteWorktreeExecutionHostId(row) ?? 'local') === hostId)
    ])
  )
  const detectedWorktreesByRepo = Object.fromEntries(
    Object.entries(selectDetectedWorktreesByRepo(state)).map(([id, entry]) => [
      id,
      {
        ...entry,
        worktrees: entry.worktrees.filter(
          (row) => (getPaletteWorktreeExecutionHostId(row) ?? 'local') === hostId
        )
      }
    ])
  )
  const preferences = readAgentLaunchPreferencesForWorkspace(state, {
    kind: 'git-worktree',
    executionHostId: hostId
  })
  // Legacy folder rows can inherit their host; preserve that proof when adapting them to worktrees.
  const folderWorkspaces = selectFolderWorkspaces(state).flatMap((workspace) => {
    const resolved = resolveQualifiedIndexedFolderWorkspace(state, workspace.id, hostId)
    return resolved.kind === 'selected' && resolved.value.workspace === workspace
      ? [{ ...workspace, executionHostId: resolved.value.hostId }]
      : []
  })
  return {
    ...state,
    repos: state.repos.filter(onHost),
    projectGroups: state.projectGroups.filter(onHost),
    folderWorkspaces,
    worktreesByRepo,
    detectedWorktreesByRepo,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    settings: state.settings
      ? {
          ...state.settings,
          ...preferences,
          // An unknown host default stays unset instead of inheriting the desktop's chosen agent.
          defaultTuiAgent: preferences.defaultTuiAgent ?? null,
          disabledTuiAgents: normalizeDisabledTuiAgents(preferences.disabledTuiAgents)
        }
      : null
  }
}

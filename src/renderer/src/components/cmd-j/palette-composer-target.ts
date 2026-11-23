import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { resolveComposerActiveRepoId } from '@/lib/workspace/creation/new-workspace-composer-repo'
import {
  resolveWorkspaceCreationTarget,
  type WorkspaceCreationTarget,
  type WorkspaceCreationTargetHint
} from '@/lib/workspace/creation/project-host-workspace-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { getNewWorkspaceDialogEligibleRepos } from '../../../../shared/new-workspace/new-workspace-dialog-repo'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../shared/execution-host/host-setting-overrides'

export type PaletteComposerTargetState = Pick<
  AppState,
  | 'repos'
  | 'projects'
  | 'projectHostSetups'
  | 'activeRepoId'
  | 'settings'
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
  | 'workspaceHostScope'
>

export function selectPaletteComposerTargetState(state: AppState): PaletteComposerTargetState {
  return {
    repos: state.repos,
    projects: state.projects,
    projectHostSetups: state.projectHostSetups,
    activeRepoId: state.activeRepoId,
    settings: state.settings,
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    workspaceHostScope: state.workspaceHostScope
  }
}

/**
 * The project the New worktree dialog resolves to when opened from the palette: the same inputs and the same
 * resolver as the dialog's own first pass (`useComposerInitialTargetState`), which opens with no draft. A dialog
 * opened for `initialRepoId` falls back to another project when that one cannot be used (not an eligible repo,
 * or a host that is not known yet), and the answer then names the other project. Empty when nothing resolves.
 */
export function resolvePaletteComposerTarget(
  state: PaletteComposerTargetState,
  initialRepoId?: string,
  workspaceTarget?: WorkspaceCreationTargetHint
): WorkspaceCreationTarget | null {
  const eligibleRepos = getNewWorkspaceDialogEligibleRepos(state.repos)
  const hostOptions = buildExecutionHostRegistry({
    repos: state.repos,
    settings: state.settings,
    hostSource: 'configured-only',
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  })
  const resolution = resolveWorkspaceCreationTarget({
    eligibleRepos,
    projects: state.projects,
    projectHostSetups: state.projectHostSetups,
    initialRepoId,
    // Match the dialog's explicit seed, including the host owning a colliding setup id.
    projectId: workspaceTarget?.projectId,
    hostId: workspaceTarget?.hostId,
    projectHostSetupId: workspaceTarget?.projectHostSetupId,
    projectHostSetupHostId: workspaceTarget?.hostId,
    activeRepoId: resolveComposerActiveRepoId(
      state.repos,
      eligibleRepos,
      state.activeRepoId,
      state.runtimeEnvironments
    ),
    focusedHostScope: state.workspaceHostScope,
    actionableHostIds: new Set(hostOptions.map((host) => host.id))
  })
  if (resolution.status !== 'ready') {
    return null
  }
  // A retained setup must not resolve through the legacy single-repo fallback on another host.
  return workspaceTarget &&
    getRepoExecutionHostId(resolution.target.repo) !== workspaceTarget.hostId
    ? null
    : resolution.target
}

export function resolvePaletteComposerRepoId(
  state: PaletteComposerTargetState,
  initialRepoId?: string
): string {
  return resolvePaletteComposerTarget(state, initialRepoId)?.repoId ?? ''
}

/**
 * Resolves true once a dialog opened for `repoId` would stay on that project, false when it still does not
 * after `timeoutMs`. The auto-submitting dialog presses Create only on the project the palette picked, so a
 * project that was just added has to be known to the store (and its host to the registry) before the name step.
 */
export function waitUntilComposerTargetsRepo(
  repoId: string,
  timeoutMs = 3000,
  workspaceTarget?: WorkspaceCreationTargetHint
): Promise<boolean> {
  const ready = (): boolean => {
    const target = resolvePaletteComposerTarget(
      selectPaletteComposerTargetState(useAppStore.getState()),
      repoId,
      workspaceTarget
    )
    return (
      target?.repoId === repoId &&
      (!workspaceTarget ||
        (target.hostId === workspaceTarget.hostId &&
          target.projectId === workspaceTarget.projectId &&
          (!workspaceTarget.projectHostSetupId ||
            target.projectHostSetupId === workspaceTarget.projectHostSetupId)))
    )
  }
  if (ready()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const unsubscribe = useAppStore.subscribe(() => {
      if (ready()) {
        finish(true)
      }
    })
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

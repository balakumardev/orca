import { useAppStore } from '@/store/index'
import {
  getRepoWorkspaceCreationTargetHint,
  type WorkspaceCreationTargetHint
} from '@/lib/workspace/creation/project-host-workspace-target'
import {
  resolvePaletteProjectCreateRepo,
  resolveProjectScopedCreate,
  selectPaletteProjectCatalog,
  type ProjectScopedCreate
} from './palette-project-create-targets'
import { getPaletteSearchHosts, type PaletteSearchHost } from './palette-search-hosts'
export { paletteSearchHostGuard as paletteProjectCreateGuard } from './palette-search-hosts'

/** The `<project>/<name>` reading of a typed query against the projects registered right now. */
export function readProjectScopedCreate(query: string): ProjectScopedCreate | null {
  return resolveProjectScopedCreate(query, selectPaletteProjectCatalog(useAppStore.getState()))
}

/**
 * Opens the new-workspace composer on one project, with a name when the palette already has one. With
 * `autoSubmit` the dialog stays hidden and presses its own Create, so the default agent, setup policy and remote
 * handling are the dialog's; it shows itself only when it needs input.
 */
export function openProjectComposer(
  repoId: string,
  name?: string,
  autoSubmit = false,
  workspaceTarget?: WorkspaceCreationTargetHint,
  host?: PaletteSearchHost
): void {
  const state = useAppStore.getState()
  const { prefetchWorktreeCreateBase, openModal, recordFeatureInteraction } = state
  const repo = resolvePaletteProjectCreateRepo(repoId, state, workspaceTarget)
  if (!repo) {
    return
  }
  const target =
    workspaceTarget ?? getRepoWorkspaceCreationTargetHint(repo, state.projectHostSetups)
  // Keep the selected pairing through the microtask and the hidden form's readiness wait.
  const autoSubmitHost =
    autoSubmit && target.hostId.startsWith('runtime:')
      ? (host ??
        getPaletteSearchHosts(state, [target.hostId]).find(
          (candidate) => candidate.executionHostId === target.hostId
        ))
      : undefined
  // The prefetch API takes only an id, so ambiguous copies must wait for the host-aware composer.
  if (state.repos.filter((candidate) => candidate.id === repoId).length === 1) {
    void prefetchWorktreeCreateBase(repoId)
  }
  void recordFeatureInteraction('cmd-j-create-workspace')
  // The palette is closing in the same tick; opening in a microtask keeps its close from taking the composer down.
  queueMicrotask(() =>
    openModal('new-workspace-composer', {
      initialRepoId: repoId,
      initialWorkspaceTarget: target,
      ...(name ? { prefilledName: name } : {}),
      ...(autoSubmit ? { autoSubmit: true } : {}),
      ...(autoSubmitHost ? { autoSubmitHost } : {}),
      telemetrySource: 'command_palette'
    })
  )
}

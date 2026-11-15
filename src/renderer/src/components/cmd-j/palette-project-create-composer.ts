import { useAppStore } from '@/store/index'
import {
  resolveProjectScopedCreate,
  selectPaletteProjectCatalog,
  type ProjectScopedCreate
} from './palette-project-create-targets'

/** The `<project>/<name>` reading of a typed query against the projects registered right now. */
export function readProjectScopedCreate(query: string): ProjectScopedCreate | null {
  return resolveProjectScopedCreate(query, selectPaletteProjectCatalog(useAppStore.getState()))
}

/**
 * Opens the new-workspace composer on one project, with a name when the palette already has one. With
 * `autoSubmit` the dialog stays hidden and presses its own Create, so the default agent, setup policy and remote
 * handling are the dialog's; it shows itself only when it needs input.
 */
export function openProjectComposer(repoId: string, name?: string, autoSubmit = false): void {
  const { prefetchWorktreeCreateBase, openModal, recordFeatureInteraction } = useAppStore.getState()
  void prefetchWorktreeCreateBase(repoId)
  void recordFeatureInteraction('cmd-j-create-workspace')
  // The palette is closing in the same tick; opening in a microtask keeps its close from taking the composer down.
  queueMicrotask(() =>
    openModal('new-workspace-composer', {
      initialRepoId: repoId,
      ...(name ? { prefilledName: name } : {}),
      ...(autoSubmit ? { autoSubmit: true } : {}),
      telemetrySource: 'command_palette'
    })
  )
}

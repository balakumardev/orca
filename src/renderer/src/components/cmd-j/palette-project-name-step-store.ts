import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import {
  getRepoWorkspaceCreationTargetHint,
  type WorkspaceCreationTargetHint
} from '@/lib/workspace/creation/project-host-workspace-target'
import { resolvePaletteProjectCreateRepo } from './palette-project-create-targets'
import {
  getPaletteSearchHosts,
  isPaletteSearchHostCurrent,
  type PaletteSearchHost
} from './palette-search-hosts'

/** The palette's second step: the project is chosen, the user types the worktree name. */
export type ProjectNameStep = {
  repoId: string
  /** The name the palette's project rows show for the project. */
  projectLabel: string
  /** Where the project lives, so two projects with one name can be told apart. */
  projectPath: string
  workspaceTarget?: WorkspaceCreationTargetHint
  host?: PaletteSearchHost
  name: string
}

let current: ProjectNameStep | null = null
const listeners = new Set<() => void>()

function publish(next: ProjectNameStep | null): void {
  current = next
  listeners.forEach((listener) => listener())
}

export function getProjectNameStep(): ProjectNameStep | null {
  return current
}

/**
 * Enters the step; ignored unless the palette is the open modal, so a stray call cannot leave a step behind.
 * Returns whether it published a step, for a caller that must tell the user when it did not.
 */
export function beginProjectNameStep(args: {
  repoId: string
  projectLabel: string
  name?: string
  workspaceTarget?: WorkspaceCreationTargetHint
  /** A saved action supplies its original authority; null means it had no live authority. */
  host?: PaletteSearchHost | null
}): boolean {
  const state = useAppStore.getState()
  if (state.activeModal !== 'worktree-palette') {
    return false
  }
  // Capture the execution target before typing can outlive the selected host's catalog row.
  const repo = resolvePaletteProjectCreateRepo(args.repoId, state, args.workspaceTarget)
  if (!repo) {
    return false
  }
  const workspaceTarget =
    args.workspaceTarget ?? getRepoWorkspaceCreationTargetHint(repo, state.projectHostSetups)
  // Validate the selected pairing before global search deduplicates aliases of the same server.
  const host =
    args.host === undefined
      ? getPaletteSearchHosts(state, [workspaceTarget.hostId]).find(
          (candidate) => candidate.executionHostId === workspaceTarget.hostId
        )
      : args.host
  // A paired-server name step must not survive a different authority taking its saved host id.
  if (
    (host &&
      (host.executionHostId !== workspaceTarget.hostId ||
        !isPaletteSearchHostCurrent(host, state))) ||
    (workspaceTarget.hostId.startsWith('runtime:') && !host)
  ) {
    return false
  }
  publish({
    repoId: args.repoId,
    projectLabel: args.projectLabel,
    projectPath: repo.path,
    workspaceTarget,
    host: host ?? undefined,
    name: args.name ?? ''
  })
  return true
}

export function setProjectNameStepName(name: string): void {
  if (current) {
    publish({ ...current, name })
  }
}

export function endProjectNameStep(): void {
  if (current) {
    publish(null)
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useProjectNameStep(): ProjectNameStep | null {
  return useSyncExternalStore(subscribe, getProjectNameStep, getProjectNameStep)
}

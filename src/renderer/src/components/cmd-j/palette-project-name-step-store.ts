import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'

/** The palette's second step: the project is chosen, the user types the worktree name. */
export type ProjectNameStep = {
  repoId: string
  /** The name the palette's project rows show for the project. */
  projectLabel: string
  /** Where the project lives, so two projects with one name can be told apart. */
  projectPath: string
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

/** Enters the step; ignored unless the palette is the open modal, so a stray call cannot leave a step behind. */
export function beginProjectNameStep(args: {
  repoId: string
  projectLabel: string
  name?: string
}): void {
  const state = useAppStore.getState()
  if (state.activeModal !== 'worktree-palette') {
    return
  }
  publish({
    repoId: args.repoId,
    projectLabel: args.projectLabel,
    projectPath: state.repos.find((repo) => repo.id === args.repoId)?.path ?? '',
    name: args.name ?? ''
  })
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

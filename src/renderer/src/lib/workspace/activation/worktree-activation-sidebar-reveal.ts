import type { AppState } from '@/store/types'
import type { WorktreeActivationOptions } from './worktree-activation-surface-selection'

/** Reveals an activated worktree; the behavior and host go along only when the caller named them. */
export function revealActivatedWorktreeInSidebar(
  state: Pick<AppState, 'revealWorktreeInSidebar'>,
  worktreeId: string,
  opts: Pick<WorktreeActivationOptions, 'sidebarRevealBehavior' | 'executionHostId'> | undefined
): void {
  if (opts?.sidebarRevealBehavior || opts?.executionHostId) {
    state.revealWorktreeInSidebar(worktreeId, {
      ...(opts.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {}),
      ...(opts.executionHostId ? { executionHostId: opts.executionHostId } : {})
    })
  } else {
    state.revealWorktreeInSidebar(worktreeId)
  }
}

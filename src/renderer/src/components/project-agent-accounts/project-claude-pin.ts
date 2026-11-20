import { useAppStore } from '@/store/index'
import { getCodexSelectionLaneKey } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { ClaudeManagedAccount } from '../../../../shared/agent-accounts/managed-account-types'
import type {
  ProjectAgentAccountChoice,
  ProjectAgentAccountsSnapshot
} from '../../../../shared/project-agent-accounts'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { findPinnableProjectRepo } from './project-agent-account-repo'
import {
  getProjectAgentAccountChoice,
  readProjectAgentAccounts,
  useProjectAgentAccounts
} from './project-agent-accounts-store'

type SavedClaudeAccount = Pick<ClaudeManagedAccount, 'id' | 'managedAuthRuntime'>

const HOST_LANE_KEY = getCodexSelectionLaneKey(null)

/** Main drops a pin whose account is gone or left the host; the project then follows the active account. */
export function projectClaudePinApplies(
  choice: ProjectAgentAccountChoice | undefined,
  saved: readonly SavedClaudeAccount[]
): boolean {
  if (!choice) {
    return false
  }
  return (
    choice.kind === 'system' ||
    saved.some(
      (account) =>
        account.id === choice.accountId && (account.managedAuthRuntime ?? 'host') === 'host'
    )
  )
}

function isWorktreeClaudePinned(
  snapshot: ProjectAgentAccountsSnapshot,
  repos: readonly Repo[],
  saved: readonly SavedClaudeAccount[],
  worktreeId: string
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return (
    projectClaudePinApplies(getProjectAgentAccountChoice(snapshot, repoId, 'claude'), saved) &&
    findPinnableProjectRepo(repos, repoId) !== undefined
  )
}

/** A global switch never moves this pane: its restart relaunches on the project's account. */
export function isProjectClaudeBoundPane(
  pane: { worktreeId: string; laneKey: string },
  saved: readonly SavedClaudeAccount[]
): boolean {
  // Pins route host shells only; a WSL shell signs in with its distro's accounts.
  if (pane.laneKey !== HOST_LANE_KEY) {
    return false
  }
  const { snapshot } = readProjectAgentAccounts()
  return isWorktreeClaudePinned(snapshot, useAppStore.getState().repos, saved, pane.worktreeId)
}

export function useProjectClaudePinnedTerminalTab(tabId: string): boolean {
  const { snapshot } = useProjectAgentAccounts()
  const hasPins = Object.keys(snapshot.projects).length > 0
  return useAppStore((state) => {
    if (!hasPins) {
      return false
    }
    const tab = Object.values(state.unifiedTabsByWorktree)
      .flat()
      .find((candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId)
    return tab
      ? isWorktreeClaudePinned(
          snapshot,
          state.repos,
          state.settings?.claudeManagedAccounts ?? [],
          tab.worktreeId
        )
      : false
  })
}

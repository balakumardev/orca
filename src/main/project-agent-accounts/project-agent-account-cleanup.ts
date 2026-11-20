import {
  PROJECT_AGENT_ACCOUNT_PROVIDERS,
  type ProjectAgentAccountProvider
} from '../../shared/project-agent-accounts'
import type { Store } from '../persistence/loading-store/store'
import { isProjectAgentAccountRepo } from './project-agent-account-repo'
import {
  getProjectAgentAccountAdapter,
  getProjectAgentAccountsStore
} from './project-agent-accounts-registry'
import type { ProjectAgentAccountsStore } from './project-agent-accounts-store'

/** Call before the account's folder is deleted, so no pin or pointer can recreate it. */
export async function forgetProjectAgentAccount(
  provider: ProjectAgentAccountProvider,
  accountId: string
): Promise<void> {
  const adapter = getProjectAgentAccountAdapter(provider)
  // Without an adapter no pin to this provider can route a spawn.
  if (!adapter) {
    return
  }
  let pins: ProjectAgentAccountsStore | null = null
  try {
    pins = getProjectAgentAccountsStore()
    pins.removeAccount(provider, accountId)
  } catch (error) {
    console.warn('[project-agent-accounts] Could not drop pins to a removed account:', error)
  }
  try {
    adapter.onAccountRemoved(accountId)
  } catch (error) {
    console.warn(
      '[project-agent-accounts] Could not retire a removed account in open panes:',
      error
    )
  }
  await pins?.flush()
}

/** Best effort at startup: pins to removed projects or accounts would never route anything. */
export function pruneProjectAgentAccounts(store: Pick<Store, 'getRepos'>): void {
  try {
    const pins = getProjectAgentAccountsStore()
    pins.pruneToRepoIds(
      store
        .getRepos()
        .filter(isProjectAgentAccountRepo)
        .map((repo) => repo.id)
    )
    for (const accounts of Object.values(pins.list().projects)) {
      for (const { id: provider } of PROJECT_AGENT_ACCOUNT_PROVIDERS) {
        const choice = accounts[provider]
        const adapter = getProjectAgentAccountAdapter(provider)
        if (choice?.kind === 'account' && adapter && !adapter.isPinnableAccount(choice.accountId)) {
          pins.removeAccount(provider, choice.accountId)
        }
      }
    }
  } catch (error) {
    console.warn('[project-agent-accounts] Could not prune project account pins:', error)
  }
}

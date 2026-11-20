import { getAppEnvironment } from '../../shared/app-environment'
import type { Store } from '../persistence/loading-store/store'
import {
  ProjectClaudeBinding,
  type ProjectClaudeRouter
} from '../claude-accounts/project-binding/project-claude-binding'
import { installProjectClaudeBinding } from '../claude-accounts/project-binding/project-claude-launch'
import { pruneProjectAgentAccounts } from './project-agent-account-cleanup'
import {
  getProjectAgentAccountsStore,
  registerProjectAgentAccountAdapter
} from './project-agent-accounts-registry'

/** Desktop only: headless serve shares no pins with the desktop, so it keeps the active account. */
export function installProjectAgentAccounts(
  store: Pick<Store, 'getRepos'>,
  claudeRouter: ProjectClaudeRouter
): void {
  try {
    const claude = new ProjectClaudeBinding({
      router: claudeRouter,
      dataRoot: getAppEnvironment().getPath('userData'),
      pins: getProjectAgentAccountsStore(),
      store
    })
    registerProjectAgentAccountAdapter(claude)
    installProjectClaudeBinding(claude)
    pruneProjectAgentAccounts(store)
  } catch (error) {
    console.warn('[project-agent-accounts] Could not start per-project agent accounts:', error)
  }
}

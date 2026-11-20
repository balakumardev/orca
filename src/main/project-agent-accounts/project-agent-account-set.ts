import {
  normalizeProjectAgentAccountSetRequest,
  PROJECT_AGENT_ACCOUNT_PROVIDERS,
  type ProjectAgentAccountsSnapshot
} from '../../shared/project-agent-accounts'
import {
  findProjectAgentAccountRepo,
  type ProjectAgentAccountRepoStore
} from './project-agent-account-repo'
import {
  getProjectAgentAccountAdapter,
  getProjectAgentAccountsStore
} from './project-agent-accounts-registry'

/** The renderer is untrusted input: every pin is checked against this computer's projects and accounts. */
export async function setProjectAgentAccount(
  store: ProjectAgentAccountRepoStore,
  rawRequest: unknown
): Promise<ProjectAgentAccountsSnapshot> {
  const request = normalizeProjectAgentAccountSetRequest(rawRequest)
  if (!request) {
    throw new Error('Invalid project account request.')
  }
  if (!store.getRepos().some((repo) => repo.id === request.repoId)) {
    throw new Error('That project no longer exists.')
  }
  if (!findProjectAgentAccountRepo(store, request.repoId)) {
    throw new Error('Only Git projects on this computer can choose an agent account.')
  }
  const adapter = getProjectAgentAccountAdapter(request.provider)
  const label =
    PROJECT_AGENT_ACCOUNT_PROVIDERS.find((provider) => provider.id === request.provider)?.label ??
    request.provider
  if (request.choice && !adapter) {
    throw new Error(`${label} accounts cannot be chosen per project here.`)
  }
  if (request.choice?.kind === 'account' && !adapter?.isPinnableAccount(request.choice.accountId)) {
    throw new Error(`That ${label} account does not exist or does not run on this computer.`)
  }
  return getProjectAgentAccountsStore().set(request.repoId, request.provider, request.choice)
}

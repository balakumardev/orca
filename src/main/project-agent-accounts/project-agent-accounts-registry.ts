import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { ProjectAgentAccountProvider } from '../../shared/project-agent-accounts'
import {
  createProjectAgentAccountsStore,
  PROJECT_AGENT_ACCOUNTS_FILE_NAME,
  type ProjectAgentAccountsStore
} from './project-agent-accounts-store'

/** One per provider: Codex and others plug in by registering their own. */
export type ProjectAgentAccountAdapter = {
  provider: ProjectAgentAccountProvider
  /** The account exists and runs on this computer's host runtime. */
  isPinnableAccount: (accountId: string) => boolean
  /** Runs before the account's own files are deleted. */
  onAccountRemoved: (accountId: string) => void
}

let installedStore: ProjectAgentAccountsStore | undefined
const adapters = new Map<ProjectAgentAccountProvider, ProjectAgentAccountAdapter>()

export function installProjectAgentAccountsStore(
  store: ProjectAgentAccountsStore | undefined
): void {
  installedStore = store
}

/** Created on first use, so IPC and spawns share one instance whatever the startup order. */
export function getProjectAgentAccountsStore(): ProjectAgentAccountsStore {
  installedStore ??= createProjectAgentAccountsStore(() =>
    join(getAppEnvironment().getPath('userData'), PROJECT_AGENT_ACCOUNTS_FILE_NAME)
  )
  return installedStore
}

export function registerProjectAgentAccountAdapter(
  adapter: ProjectAgentAccountAdapter
): () => void {
  adapters.set(adapter.provider, adapter)
  return () => {
    if (adapters.get(adapter.provider) === adapter) {
      adapters.delete(adapter.provider)
    }
  }
}

export function getProjectAgentAccountAdapter(
  provider: ProjectAgentAccountProvider
): ProjectAgentAccountAdapter | undefined {
  return adapters.get(provider)
}

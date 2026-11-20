/** Agent CLIs whose account a project can pin. Add a provider here and register its main-side adapter. */
export type ProjectAgentAccountProvider = 'claude'

/** No entry for a provider means the project follows the active account. */
export type ProjectAgentAccountChoice = { kind: 'account'; accountId: string } | { kind: 'system' }

export type ProjectAgentAccounts = Partial<
  Record<ProjectAgentAccountProvider, ProjectAgentAccountChoice>
>

/** Pins of the projects on this computer, keyed by repo id. */
export type ProjectAgentAccountsSnapshot = {
  projects: Record<string, ProjectAgentAccounts>
}

export type ProjectAgentAccountSetRequest = {
  repoId: string
  provider: ProjectAgentAccountProvider
  /** null clears the pin. */
  choice: ProjectAgentAccountChoice | null
}

export const PROJECT_AGENT_ACCOUNT_PROVIDERS: readonly {
  id: ProjectAgentAccountProvider
  label: string
}[] = [{ id: 'claude', label: 'Claude Code' }]

export const PROJECT_AGENT_ACCOUNTS_LIST_CHANNEL = 'projectAgentAccounts:list'
export const PROJECT_AGENT_ACCOUNTS_SET_CHANNEL = 'projectAgentAccounts:set'
export const PROJECT_AGENT_ACCOUNTS_CHANGED_CHANNEL = 'projectAgentAccounts:changed'

// Same rule as Claude profile folders; a pin names a folder and a pointer file.
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const MAX_REPO_ID_LENGTH = 512
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isProjectAgentAccountProvider(
  value: unknown
): value is ProjectAgentAccountProvider {
  return PROJECT_AGENT_ACCOUNT_PROVIDERS.some((provider) => provider.id === value)
}

export function isProjectAgentAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value)
}

export function isProjectAgentAccountRepoId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_REPO_ID_LENGTH &&
    !FORBIDDEN_KEYS.has(value)
  )
}

export function normalizeProjectAgentAccountChoice(
  value: unknown
): ProjectAgentAccountChoice | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.kind === 'system') {
    return { kind: 'system' }
  }
  if (value.kind === 'account' && isProjectAgentAccountId(value.accountId)) {
    return { kind: 'account', accountId: value.accountId }
  }
  return null
}

export function normalizeProjectAgentAccounts(value: unknown): ProjectAgentAccounts {
  const accounts: ProjectAgentAccounts = {}
  if (!isRecord(value)) {
    return accounts
  }
  for (const provider of PROJECT_AGENT_ACCOUNT_PROVIDERS) {
    const choice = normalizeProjectAgentAccountChoice(value[provider.id])
    if (choice) {
      accounts[provider.id] = choice
    }
  }
  return accounts
}

/** Drops malformed repo ids and projects left with no pin. */
export function normalizeProjectAgentAccountsByRepo(
  value: unknown
): Record<string, ProjectAgentAccounts> {
  const projects: Record<string, ProjectAgentAccounts> = {}
  if (!isRecord(value)) {
    return projects
  }
  for (const [repoId, raw] of Object.entries(value)) {
    const accounts = normalizeProjectAgentAccounts(raw)
    if (isProjectAgentAccountRepoId(repoId) && Object.keys(accounts).length > 0) {
      projects[repoId] = accounts
    }
  }
  return projects
}

/** The web client's fallback bridge answers `[]` or nothing; both read as no pins. */
export function normalizeProjectAgentAccountsSnapshot(
  value: unknown
): ProjectAgentAccountsSnapshot {
  return { projects: normalizeProjectAgentAccountsByRepo(isRecord(value) ? value.projects : null) }
}

export function normalizeProjectAgentAccountSetRequest(
  value: unknown
): ProjectAgentAccountSetRequest | null {
  if (
    !isRecord(value) ||
    !isProjectAgentAccountRepoId(value.repoId) ||
    !isProjectAgentAccountProvider(value.provider)
  ) {
    return null
  }
  if (value.choice === null) {
    return { repoId: value.repoId, provider: value.provider, choice: null }
  }
  const choice = normalizeProjectAgentAccountChoice(value.choice)
  return choice ? { repoId: value.repoId, provider: value.provider, choice } : null
}

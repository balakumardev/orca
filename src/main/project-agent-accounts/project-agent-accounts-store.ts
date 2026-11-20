import { lstatSync, readFileSync } from 'node:fs'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import {
  normalizeProjectAgentAccountsByRepo,
  type ProjectAgentAccountChoice,
  type ProjectAgentAccountProvider,
  type ProjectAgentAccounts,
  type ProjectAgentAccountsSnapshot
} from '../../shared/project-agent-accounts'

export const PROJECT_AGENT_ACCOUNTS_FILE_NAME = 'project-agent-accounts.json'
const FORMAT_VERSION = 1
const MAX_FILE_BYTES = 1024 * 1024
// Pins name this computer's accounts; another host's projects never share them.
const LOCAL_HOST_KEY = 'local'

export type ProjectAgentAccountsStore = {
  /** null means no pin: the project follows the active account. */
  get: (repoId: string, provider: ProjectAgentAccountProvider) => ProjectAgentAccountChoice | null
  set: (
    repoId: string,
    provider: ProjectAgentAccountProvider,
    choice: ProjectAgentAccountChoice | null
  ) => Promise<ProjectAgentAccountsSnapshot>
  list: () => ProjectAgentAccountsSnapshot
  /** Returns the repo ids that lost their pin. */
  removeAccount: (provider: ProjectAgentAccountProvider, accountId: string) => string[]
  pruneToRepoIds: (validRepoIds: Iterable<string>) => string[]
  subscribe: (listener: (snapshot: ProjectAgentAccountsSnapshot) => void) => () => void
  /** Resolves once every change so far is on disk. */
  flush: () => Promise<void>
}

function readPinsFile(filePath: string): Record<string, ProjectAgentAccounts> {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return {}
    }
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== FORMAT_VERSION ||
      !('hosts' in parsed) ||
      typeof parsed.hosts !== 'object' ||
      parsed.hosts === null
    ) {
      return {}
    }
    return normalizeProjectAgentAccountsByRepo(Reflect.get(parsed.hosts, LOCAL_HOST_KEY))
  } catch {
    return {}
  }
}

export function createProjectAgentAccountsStore(
  resolveFilePath: () => string
): ProjectAgentAccountsStore {
  let writer: AtomicSnapshotWriter | null = null
  let pending: Promise<void> = Promise.resolve()
  let projects: Record<string, ProjectAgentAccounts> | null = null
  const listeners = new Set<(snapshot: ProjectAgentAccountsSnapshot) => void>()

  const loaded = (): Record<string, ProjectAgentAccounts> => {
    projects ??= readPinsFile(resolveFilePath())
    return projects
  }
  const snapshot = (): ProjectAgentAccountsSnapshot => ({
    projects: structuredClone(loaded())
  })
  const commit = (next: Record<string, ProjectAgentAccounts>): Promise<void> => {
    projects = normalizeProjectAgentAccountsByRepo(next)
    const payload = `${JSON.stringify({ version: FORMAT_VERSION, hosts: { [LOCAL_HOST_KEY]: projects } }, null, 2)}\n`
    writer ??= new AtomicSnapshotWriter(resolveFilePath, { skipUnchanged: true, fileMode: 0o600 })
    const write = writer.write(() => payload)
    pending = write.catch((error: unknown) => {
      console.warn('[project-agent-accounts] Could not save project account pins:', error)
    })
    const current = snapshot()
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (error) {
        console.warn('[project-agent-accounts] A pins listener failed:', error)
      }
    }
    return write
  }
  // `keep` returns the same object to leave a project alone, a smaller one or null to drop pins.
  const rewrite = (
    keep: (repoId: string, accounts: ProjectAgentAccounts) => ProjectAgentAccounts | null
  ): string[] => {
    const next: Record<string, ProjectAgentAccounts> = {}
    const affected: string[] = []
    for (const [repoId, accounts] of Object.entries(loaded())) {
      const kept = keep(repoId, accounts)
      if (kept === accounts) {
        next[repoId] = accounts
        continue
      }
      affected.push(repoId)
      if (kept && Object.keys(kept).length > 0) {
        next[repoId] = kept
      }
    }
    if (affected.length > 0) {
      void commit(next).catch(() => {})
    }
    return affected
  }

  return {
    get: (repoId, provider) => {
      const choice = Object.hasOwn(loaded(), repoId) ? loaded()[repoId][provider] : undefined
      return choice ? { ...choice } : null
    },
    set: async (repoId, provider, choice) => {
      const current = loaded()
      const accounts: ProjectAgentAccounts = {
        ...(Object.hasOwn(current, repoId) ? current[repoId] : {})
      }
      if (choice) {
        accounts[provider] = choice
      } else {
        delete accounts[provider]
      }
      await commit({ ...current, [repoId]: accounts })
      return snapshot()
    },
    list: snapshot,
    removeAccount: (provider, accountId) =>
      rewrite((_repoId, accounts) => {
        const choice = accounts[provider]
        if (choice?.kind !== 'account' || choice.accountId !== accountId) {
          return accounts
        }
        const kept = { ...accounts }
        delete kept[provider]
        return kept
      }),
    pruneToRepoIds: (validRepoIds) => {
      const valid = new Set(validRepoIds)
      return rewrite((repoId, accounts) => (valid.has(repoId) ? accounts : null))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    flush: async () => {
      await pending
    }
  }
}

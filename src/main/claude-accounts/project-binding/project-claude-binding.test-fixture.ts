import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import type { Repo } from '../../../shared/repo-types'
import { createProjectAgentAccountsStore } from '../../project-agent-accounts/project-agent-accounts-store'
import {
  describeClaudeProfile,
  prepareClaudeProfileDirectory
} from '../profiles/claude-profile-paths'
import { installClaudeProfileRouter } from '../profiles/routing/claude-profile-installed-router'
import {
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../profiles/routing/claude-profile-router'
import type { ClaudeProfileSetupReport } from '../profiles/setup/claude-profile-setup'
import { ProjectClaudeBinding } from './project-claude-binding'
import { installProjectClaudeBinding } from './project-claude-launch'

const roots: string[] = []

export function removeProjectClaudeFixtures(): void {
  installProjectClaudeBinding(undefined)
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
}

const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path: `/projects/${id}`,
  displayName: id,
  badgeColor: '#000000',
  addedAt: 0,
  ...extra
})
// Remote twins share the local project's id and come first, as a first-row lookup would hit them.
const repos = [
  repo('local', { connectionId: 'target-1' }),
  repo('local', { executionHostId: 'runtime:env-1' }),
  repo('local'),
  repo('folder', { kind: 'folder' }),
  repo('ssh', { connectionId: 'target-1' }),
  repo('runtime', { executionHostId: 'runtime:env-1' })
]
export const projectClaudeTestStore = {
  getRepo: (id: string) => repos.find((entry) => entry.id === id),
  getRepos: () => repos
}
export const projectClaudeTestWorktree = (repoId: string) => `${repoId}::/projects/${repoId}/wt`

const account = (id: string, extra: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount => ({
  id,
  email: `${id}@example.test`,
  authMethod: 'subscription-oauth',
  managedAuthPath: '/unused-legacy',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0,
  ...extra
})

/** Accounts a, b and c are signed in to their own folders; w is a WSL account; a is active. */
export function createProjectClaudeFixture(loginShellEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'project-claude-'))
  roots.push(root)
  const userHome = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [
      account('a'),
      account('b'),
      account('c'),
      account('w', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    // Avoid probing an installed Claude binary.
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const setup: { outcome: ClaudeProfileSetupReport['outcome'] } = { outcome: 'prepared' }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot,
    userHome,
    env: loginShellEnv,
    refreshWaitMs: 50,
    runSetup: async ({ profile }) => {
      if (setup.outcome === 'prepared') {
        prepareClaudeProfileDirectory(dataRoot, profile, userHome)()
      }
      return { outcome: setup.outcome, warnings: [], surfaces: {} }
    }
  })
  installClaudeProfileRouter(router)
  const pins = createProjectAgentAccountsStore(() => join(root, 'pins.json'))
  const binding = new ProjectClaudeBinding({
    router,
    dataRoot,
    pins,
    store: projectClaudeTestStore
  })
  installProjectClaudeBinding(binding)
  const home = (id: string) => join(dataRoot, 'claude-profiles', id, 'home')
  for (const id of ['a', 'b', 'c']) {
    const profile = describeClaudeProfile(dataRoot, id, {
      executionHostId: 'local',
      runtime: 'host'
    })
    prepareClaudeProfileDirectory(dataRoot, profile, userHome)()
    writeFileSync(
      join(home(id), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.test` } })
    )
  }
  const pointer = (...name: string[]) =>
    join(dataRoot, 'project-agent-accounts', 'pointers', 'claude', ...name)
  return { root, dataRoot, userHome, settings, setup, router, pins, binding, home, pointer }
}

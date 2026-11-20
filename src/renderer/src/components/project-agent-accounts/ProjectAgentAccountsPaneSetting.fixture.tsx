import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/agent-accounts/managed-account-types'
import type { ProjectAgentAccountsSnapshot } from '../../../../shared/project-agent-accounts'
import type { Repo } from '../../../../shared/repository/repo-types'
import { SettingsGroup } from '../settings/section-layout/SettingsGroup'
import { ProjectAgentAccountsPaneSetting } from './ProjectAgentAccountsPaneSetting'
import { ProjectAgentAccountsRepositorySection } from './ProjectAgentAccountsRepositorySection'

function repo(id: string, displayName: string, badgeColor: string, extra: Partial<Repo> = {}) {
  return {
    id,
    path: `/Users/dev/code/${displayName}`,
    displayName,
    badgeColor,
    addedAt: 1,
    ...extra
  }
}

const REPOS: Repo[] = [
  repo('repo-orca', 'orca', '#7c3aed'),
  repo('repo-site', 'balakumar.dev-portfolio-site', '#0ea5e9'),
  repo('repo-tools', 'home-network-tools', '#22c55e'),
  repo('repo-remote', 'remote-service', '#f97316', { connectionId: 'ssh-devbox' })
]

function account(id: string, email: string) {
  return {
    id,
    email,
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

const TWO_ACCOUNTS: ClaudeRateLimitAccountsState = {
  accounts: [
    account('work', 'bala.kumar@example-company.com'),
    account('personal', 'me@example.com')
  ],
  activeAccountId: 'work',
  activeAccountIdsByRuntime: { host: 'work', wsl: {} }
}

const PINS: ProjectAgentAccountsSnapshot = {
  projects: {
    'repo-orca': { claude: { kind: 'account', accountId: 'personal' } },
    'repo-site': { claude: { kind: 'system' } }
  }
}

// The pin store lives for the page; fixtures that reuse the page reach it through its change listener.
const pinListeners = new Set<(snapshot: ProjectAgentAccountsSnapshot) => void>()

function installBridge(accounts: ClaudeRateLimitAccountsState, pins: ProjectAgentAccountsSnapshot) {
  return () => {
    window.api.projectAgentAccounts = {
      list: async () => pins,
      set: async () => pins,
      onChanged: (listener) => {
        pinListeners.add(listener)
        return () => pinListeners.delete(listener)
      }
    }
    window.api.claudeAccounts.list = async () => accounts
    window.api.codexAccounts.list = async () => ({ accounts: [], activeAccountId: null })
    for (const listener of pinListeners) {
      listener(pins)
    }
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="settings-view-shell p-4">
      <SettingsGroup title="Claude">{children}</SettingsGroup>
    </div>
  )
}

export const accountsPane = defineFixture({
  width: 640,
  store: { repos: REPOS },
  setup: installBridge(TWO_ACCOUNTS, PINS),
  render: () => (
    <Card>
      <ProjectAgentAccountsPaneSetting provider="claude" />
    </Card>
  )
})

export const accountsPaneOneAccount = defineFixture({
  width: 640,
  store: { repos: REPOS },
  setup: installBridge(
    { ...TWO_ACCOUNTS, accounts: TWO_ACCOUNTS.accounts.slice(0, 1) },
    {
      projects: {}
    }
  ),
  render: () => (
    <Card>
      <ProjectAgentAccountsPaneSetting provider="claude" />
    </Card>
  )
})

export const projectSettings = defineFixture({
  width: 640,
  store: { repos: REPOS },
  setup: installBridge(TWO_ACCOUNTS, PINS),
  render: () => (
    <Card>
      <ProjectAgentAccountsRepositorySection repo={REPOS[0]} />
    </Card>
  )
})

export const projectSettingsRemote = defineFixture({
  width: 640,
  store: { repos: REPOS },
  setup: installBridge(TWO_ACCOUNTS, PINS),
  render: () => (
    <Card>
      <ProjectAgentAccountsRepositorySection repo={REPOS[3]} />
    </Card>
  )
})

export const projectSettingsNoAccounts = defineFixture({
  width: 640,
  store: { repos: REPOS },
  setup: installBridge({ ...TWO_ACCOUNTS, accounts: [], activeAccountId: null }, { projects: {} }),
  render: () => (
    <Card>
      <ProjectAgentAccountsRepositorySection repo={REPOS[2]} />
    </Card>
  )
})

export const accountsPaneNarrow = defineFixture({ ...accountsPane, width: 420 })

export const pinPickerOpen = defineFixture({
  ...accountsPane,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.click()
  }
})

import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { ProjectAgentAccountsSnapshot } from '../../../../shared/project-agent-accounts'
import { ProjectAgentAccountStatusSegment } from './ProjectAgentAccountStatusSegment'

const PINS: ProjectAgentAccountsSnapshot = {
  projects: { 'repo-orca': { claude: { kind: 'account', accountId: 'personal' } } }
}
const pinListeners = new Set<(snapshot: ProjectAgentAccountsSnapshot) => void>()

const pinned = defineFixture({
  width: 360,
  store: {
    repos: [
      {
        id: 'repo-orca',
        path: '/Users/dev/code/orca',
        displayName: 'orca',
        badgeColor: '#7c3aed',
        addedAt: 1
      }
    ],
    activeWorktreeId: 'repo-orca::/Users/dev/code/orca',
    settings: {
      ...getDefaultSettings('/Users/dev'),
      claudeManagedAccounts: [
        {
          id: 'personal',
          email: 'me@example.com',
          managedAuthPath: '/tmp/personal',
          authMethod: 'subscription-oauth',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    }
  },
  setup: () => {
    window.api.projectAgentAccounts = {
      list: async () => PINS,
      set: async () => PINS,
      onChanged: (listener) => {
        pinListeners.add(listener)
        return () => pinListeners.delete(listener)
      }
    }
    for (const listener of pinListeners) {
      listener(PINS)
    }
  },
  render: () => (
    <div className="flex h-6 items-center gap-3 border-t border-border bg-card px-3 text-xs">
      <ProjectAgentAccountStatusSegment iconOnly={false} />
    </div>
  )
})

export const label = pinned

export const iconOnly = defineFixture({
  ...pinned,
  render: () => (
    <div className="flex h-6 items-center gap-3 border-t border-border bg-card px-3 text-xs">
      <ProjectAgentAccountStatusSegment iconOnly />
    </div>
  )
})

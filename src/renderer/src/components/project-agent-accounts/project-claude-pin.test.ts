import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as projectAgentAccountsStore from './project-agent-accounts-store'
import type { ProjectAgentAccountsSnapshot } from '../../../../shared/project-agent-accounts'
import type { Repo } from '../../../../shared/repository/repo-types'
import { isProjectClaudeBoundPane } from './project-claude-pin'

let pins: ProjectAgentAccountsSnapshot = { projects: {} }

vi.mock('./project-agent-accounts-store', async (importOriginal) => ({
  ...(await importOriginal<typeof projectAgentAccountsStore>()),
  readProjectAgentAccounts: () => ({ available: true, snapshot: pins })
}))

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/src/${id}`,
    displayName: id,
    badgeColor: '#888888',
    addedAt: 1,
    ...overrides
  }
}

const SAVED = [{ id: 'acct-a' }, { id: 'acct-wsl', managedAuthRuntime: 'wsl' as const }]
const pane = (repoId: string, laneKey = 'host') => ({
  worktreeId: `${repoId}::/src/${repoId}`,
  laneKey
})

beforeEach(() => {
  pins = {
    projects: {
      local: { claude: { kind: 'account', accountId: 'acct-a' } },
      system: { claude: { kind: 'system' } },
      removed: { claude: { kind: 'account', accountId: 'acct-gone' } },
      wslAccount: { claude: { kind: 'account', accountId: 'acct-wsl' } },
      twin: { claude: { kind: 'account', accountId: 'acct-a' } },
      folder: { claude: { kind: 'system' } }
    }
  }
  useAppStore.setState({
    repos: [
      repo('local'),
      repo('system'),
      repo('removed'),
      repo('wslAccount'),
      repo('unpinned'),
      repo('twin', { connectionId: 'ssh-1' }),
      repo('folder', { kind: 'folder' })
    ]
  })
})

it("binds only host shells of this computer's git projects whose pin main still routes", () => {
  expect(isProjectClaudeBoundPane(pane('local'), SAVED)).toBe(true)
  expect(isProjectClaudeBoundPane(pane('system'), SAVED)).toBe(true)
  expect(isProjectClaudeBoundPane(pane('local', 'wsl:Ubuntu'), SAVED)).toBe(false)
  expect(isProjectClaudeBoundPane(pane('removed'), SAVED)).toBe(false)
  expect(isProjectClaudeBoundPane(pane('wslAccount'), SAVED)).toBe(false)
  expect(isProjectClaudeBoundPane(pane('unpinned'), SAVED)).toBe(false)
  expect(isProjectClaudeBoundPane(pane('twin'), SAVED)).toBe(false)
  expect(isProjectClaudeBoundPane(pane('folder'), SAVED)).toBe(false)
})

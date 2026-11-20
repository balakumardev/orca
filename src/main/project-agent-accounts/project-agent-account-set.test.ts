import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repository/repo-types'
import { setProjectAgentAccount } from './project-agent-account-set'
import {
  getProjectAgentAccountsStore,
  installProjectAgentAccountsStore,
  registerProjectAgentAccountAdapter
} from './project-agent-accounts-registry'
import { createProjectAgentAccountsStore } from './project-agent-accounts-store'

const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path: `/projects/${id}`,
  displayName: id,
  badgeColor: '#000000',
  addedAt: 0,
  ...extra
})
// The SSH twin shares the local project's id and comes first.
const repos = [
  repo('local', { connectionId: 'target-1' }),
  repo('local'),
  repo('folder', { kind: 'folder' }),
  repo('ssh', { connectionId: 'target-1' }),
  repo('runtime', { executionHostId: 'runtime:env-1' })
]
const store = { getRepos: () => repos }

let root = ''
let unregister = (): void => {}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-agent-account-set-'))
  installProjectAgentAccountsStore(createProjectAgentAccountsStore(() => join(root, 'pins.json')))
  unregister = registerProjectAgentAccountAdapter({
    provider: 'claude',
    isPinnableAccount: (accountId) => accountId === 'host-account',
    onAccountRemoved: () => {}
  })
})
afterEach(() => {
  unregister()
  installProjectAgentAccountsStore(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('setting a project agent account', () => {
  it('pins and clears a local git project whose id an SSH twin shares', async () => {
    await expect(
      setProjectAgentAccount(store, {
        repoId: 'local',
        provider: 'claude',
        choice: { kind: 'account', accountId: 'host-account' }
      })
    ).resolves.toEqual({
      projects: { local: { claude: { kind: 'account', accountId: 'host-account' } } }
    })
    await expect(
      setProjectAgentAccount(store, { repoId: 'local', provider: 'claude', choice: null })
    ).resolves.toEqual({ projects: {} })
  })

  it('refuses projects off this computer, folders, unknown projects and unusable accounts', async () => {
    const system = { kind: 'system' }
    for (const request of [
      { repoId: 'gone', provider: 'claude', choice: system },
      { repoId: 'folder', provider: 'claude', choice: system },
      { repoId: 'ssh', provider: 'claude', choice: system },
      { repoId: 'runtime', provider: 'claude', choice: system },
      {
        repoId: 'local',
        provider: 'claude',
        choice: { kind: 'account', accountId: 'wsl-account' }
      },
      null,
      { repoId: 'local', provider: 'codex', choice: system },
      { repoId: 'local', provider: 'claude', choice: { kind: 'account', accountId: '../x' } }
    ]) {
      await expect(setProjectAgentAccount(store, request)).rejects.toThrow()
    }
    expect(getProjectAgentAccountsStore().list()).toEqual({ projects: {} })
  })
})

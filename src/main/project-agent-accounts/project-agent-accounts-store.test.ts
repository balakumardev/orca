import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProjectAgentAccountsStore } from './project-agent-accounts-store'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function pinsFile(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'project-agent-accounts-'))
  roots.push(root)
  const file = join(root, 'project-agent-accounts.json')
  if (contents !== undefined) {
    writeFileSync(file, contents)
  }
  return file
}

describe('project agent account pins', () => {
  it('keeps only well-formed pins of this computer', () => {
    const file = pinsFile(
      JSON.stringify({
        version: 1,
        hosts: {
          local: {
            'repo-a': { claude: { kind: 'account', accountId: 'acct-1' } },
            'repo-b': { claude: { kind: 'system' } },
            'repo-c': { claude: { kind: 'account', accountId: '../escape' } },
            'repo-d': { claude: { kind: 'follow' } },
            'repo-e': { codex: { kind: 'system' } },
            '': { claude: { kind: 'system' } }
          },
          'runtime:env-1': { 'repo-f': { claude: { kind: 'system' } } }
        }
      })
    )
    const pins = createProjectAgentAccountsStore(() => file)
    expect(pins.list()).toEqual({
      projects: {
        'repo-a': { claude: { kind: 'account', accountId: 'acct-1' } },
        'repo-b': { claude: { kind: 'system' } }
      }
    })
    expect(pins.get('repo-f', 'claude')).toBeNull()
    expect(pins.get('repo-c', 'claude')).toBeNull()
  })

  it('persists pins and clears them with null', async () => {
    const file = pinsFile()
    const pins = createProjectAgentAccountsStore(() => file)
    await pins.set('repo-a', 'claude', { kind: 'account', accountId: 'acct-1' })
    await pins.set('repo-b', 'claude', { kind: 'system' })
    await pins.set('repo-b', 'claude', null)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      hosts: { local: { 'repo-a': { claude: { kind: 'account', accountId: 'acct-1' } } } }
    })
    const reopened = createProjectAgentAccountsStore(() => file)
    expect(reopened.get('repo-a', 'claude')).toEqual({ kind: 'account', accountId: 'acct-1' })
    expect(reopened.get('repo-b', 'claude')).toBeNull()
  })

  it('starts empty from a corrupt or foreign file and can still save', async () => {
    for (const contents of ['{"version":1,"hosts":', '{"version":2,"hosts":{}}', '[]']) {
      const file = pinsFile(contents)
      const pins = createProjectAgentAccountsStore(() => file)
      expect(pins.list()).toEqual({ projects: {} })
      await pins.set('repo-a', 'claude', { kind: 'system' })
      expect(createProjectAgentAccountsStore(() => file).get('repo-a', 'claude')).toEqual({
        kind: 'system'
      })
    }
  })

  it('drops every pin to a removed account and to projects that are gone', async () => {
    const file = pinsFile()
    const pins = createProjectAgentAccountsStore(() => file)
    await pins.set('repo-a', 'claude', { kind: 'account', accountId: 'acct-1' })
    await pins.set('repo-b', 'claude', { kind: 'account', accountId: 'acct-1' })
    await pins.set('repo-c', 'claude', { kind: 'account', accountId: 'acct-2' })
    await pins.set('repo-d', 'claude', { kind: 'system' })
    const changes: unknown[] = []
    pins.subscribe((snapshot) => changes.push(snapshot))

    expect(pins.removeAccount('claude', 'acct-1')).toEqual(['repo-a', 'repo-b'])
    expect(pins.pruneToRepoIds(['repo-c'])).toEqual(['repo-d'])
    await pins.flush()

    const expected = {
      projects: { 'repo-c': { claude: { kind: 'account', accountId: 'acct-2' } } }
    }
    expect(createProjectAgentAccountsStore(() => file).list()).toEqual(expected)
    expect(changes.at(-1)).toEqual(expected)
    expect(pins.removeAccount('claude', 'acct-1')).toEqual([])
  })
})

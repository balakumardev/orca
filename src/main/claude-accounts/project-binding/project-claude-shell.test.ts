import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPosixClaudeShellFunction } from '../../../shared/claude-shell-function'
import { ClaudeAccountSelection } from '../selection/claude-account-selection'
import {
  installProjectAgentAccountsStore,
  registerProjectAgentAccountAdapter
} from '../../project-agent-accounts/project-agent-accounts-registry'
import {
  createProjectClaudeFixture,
  projectClaudeTestStore as store,
  projectClaudeTestWorktree as worktree,
  removeProjectClaudeFixtures
} from './project-claude-binding.test-fixture'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../../codex-cli/command', () => ({ resolveClaudeCommand: () => '/unused-claude' }))
// Account removal must never reach the real Keychain.
vi.mock('../../macos-keychain/generic-password', () => ({
  execSecurityCommand: async () => {
    throw new Error('The specified item could not be found in the keychain.')
  }
}))

// Skip a missing zsh instead of failing with exit 127 on CI images.
const SHELLS = ['/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell))
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  installProjectAgentAccountsStore(undefined)
  removeProjectClaudeFixtures()
})

function fixture(loginShellEnv: NodeJS.ProcessEnv = {}) {
  const f = createProjectClaudeFixture(loginShellEnv)
  installProjectAgentAccountsStore(f.pins)
  cleanups.push(registerProjectAgentAccountAdapter(f.binding))
  const bin = join(f.root, 'bin')
  mkdirSync(bin)
  const fake = join(bin, 'claude')
  writeFileSync(fake, '#!/bin/sh\nprintf "%s" "${CLAUDE_CONFIG_DIR-unset}"\n')
  chmodSync(fake, 0o700)
  // The pane env a plain terminal gets: the active account's terminal env, then the project pin.
  const pane = (repoId: string): Record<string, string> => {
    const env = f.router.terminalEnv({ runtime: 'host' })
    const project = f.binding.resolve(store, { worktreeId: worktree(repoId) }, { runtime: 'host' })
    return project ? project.applyToEnv(env) : { ...env }
  }
  // A cleared environment: nothing from the Orca terminal running these tests reaches the shell.
  const claude = (shell: string, env: Record<string, string>): string => {
    const result = spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${f.root}`,
        `PATH=${bin}:/usr/bin:/bin`,
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        shell,
        ...(shell.endsWith('zsh') ? ['-f'] : ['--norc', '--noprofile']),
        '-c',
        `[ "$(command -v claude)" = '${fake}' ] || exit 97\n${getPosixClaudeShellFunction()}\nclaude`
      ],
      { encoding: 'utf8', cwd: f.root }
    )
    expect(result.status).not.toBe(97)
    expect(result.stderr).toBe('')
    return result.stdout
  }
  return { ...f, pane, claude }
}

describe.skipIf(process.platform === 'win32')('a typed claude in a pinned project pane', () => {
  it('runs the pinned account whichever account is active, before and after a switch', async () => {
    for (const shell of SHELLS) {
      const f = fixture()
      await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
      const pinned = f.pane('local')
      const unpinned = f.pane('folder')
      expect(f.claude(shell, pinned)).toBe(f.home('b'))
      expect(f.claude(shell, unpinned)).toBe(f.home('a'))

      f.settings.activeClaudeManagedAccountId = 'c'
      f.router.publish()
      expect(f.claude(shell, pinned)).toBe(f.home('b'))
      expect(f.claude(shell, unpinned)).toBe(f.home('c'))
    }
  })

  it('runs System default when pinned to it while a managed account is active', async () => {
    for (const shell of SHELLS) {
      for (const own of [resolve('/user/own'), undefined]) {
        const f = fixture(own ? { CLAUDE_CONFIG_DIR: own } : {})
        await f.pins.set('local', 'claude', { kind: 'system' })
        expect(f.claude(shell, f.pane('local'))).toBe(own ?? 'unset')
      }
    }
  })

  it('falls back to System default once the pinned account is removed, without recreating its folder', async () => {
    for (const shell of SHELLS) {
      const f = fixture()
      await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
      const pinned = f.pane('local')
      expect(f.claude(shell, pinned)).toBe(f.home('b'))

      const selection = new ClaudeAccountSelection(
        {
          getSettings: () => f.settings,
          updateSettings: (patch) => Object.assign(f.settings, patch)
        },
        {
          evictInactiveClaudeCache: () => {},
          refreshForClaudeAccountChange: () => new Promise<never>(() => {})
        },
        {
          syncForCurrentSelection: async () => f.router.publish(),
          publishAll: async () => f.router.publish(),
          removeAccountFolder: (accountId) => f.router.removeAccount(accountId),
          prepareAccountFolder: async () => {
            throw new Error('not used')
          },
          router: f.router
        }
      )
      await selection.remove('b')
      expect(f.claude(shell, pinned)).toBe('unset')
      expect(existsSync(f.home('b'))).toBe(false)
      expect(f.pins.get('local', 'claude')).toBeNull()
      expect(f.claude(shell, f.pane('local'))).toBe(f.home('a'))
    }
  })
})

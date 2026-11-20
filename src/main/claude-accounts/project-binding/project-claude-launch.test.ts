import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { preparePtyIpcSpawnPreflight } from '../../ipc/pty/ipc/spawn-preflight'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { prepareRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-preflight'
import { makeRuntimePtySpawnTestDeps } from '../../ipc/pty/runtime/spawn-preflight-test-deps-fixture'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import {
  createProjectClaudeFixture,
  projectClaudeTestStore as store,
  projectClaudeTestWorktree as worktree,
  removeProjectClaudeFixtures
} from './project-claude-binding.test-fixture'
import { installProjectClaudeBinding } from './project-claude-launch'

const POINTER = 'ORCA_CLAUDE_PROFILE_POINTER'
const INJECTED = 'ORCA_CLAUDE_INJECTED_CONFIG_DIR'
afterEach(removeProjectClaudeFixtures)
const withoutPointer = (env: Record<string, string> | undefined) => ({ ...env, [POINTER]: '' })

type Preflight = 'renderer' | 'runtime'

function fixture(preflight: Preflight, loginShellEnv: NodeJS.ProcessEnv = {}) {
  const f = createProjectClaudeFixture(loginShellEnv)
  const prepareClaudeAuth = vi.fn(() => f.router.prepareLaunch())
  const spawn = async (worktreeId: string, command?: string) => {
    const args = { cols: 80, rows: 24, cwd: f.root, worktreeId, command, shellOverride: '/bin/zsh' }
    if (preflight === 'runtime') {
      const ctx = createRuntimePtySpawnState(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight reads only getRepos from the store.
        { ...makeRuntimePtySpawnTestDeps('/bin/zsh'), store: store as never, prepareClaudeAuth },
        args
      )
      try {
        await prepareRuntimePtySpawn(ctx)
      } finally {
        ctx.finishTerminalInstall()
      }
      return { env: ctx.args.env, claudeAuth: ctx.claudeAuth }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight reads only these dependencies for a local, non-daemon spawn.
    const deps = {
      store,
      getSettings: () => getDefaultSettings(f.userHome),
      prepareClaudeAuth,
      assertWorkspaceAcceptsNewPty: () => undefined,
      resolvePtySpawnStartupCwd: (_id: string | undefined, cwd: string | undefined) => cwd,
      transitionSpawnHiddenRendererPtyDeliveryState: () => {}
    } as unknown as PtySpawnIpcDeps
    const ctx = createPtyIpcSpawnState(deps, args)
    try {
      await preparePtyIpcSpawnPreflight(ctx)
    } finally {
      ctx.finishTerminalInstall()
    }
    return { env: ctx.args.env, claudeAuth: ctx.claudeAuth }
  }
  return { ...f, prepareClaudeAuth, spawn }
}

describe.each<Preflight>(['renderer', 'runtime'])(
  'Claude in a pinned project, %s preflight',
  (preflight) => {
    it('leaves an unpinned project exactly as the active account makes it', async () => {
      const f = fixture(preflight)
      installProjectClaudeBinding(undefined)
      const withoutFeature = await f.spawn(worktree('local'), 'claude')
      installProjectClaudeBinding(f.binding)
      const unpinned = await f.spawn(worktree('local'), 'claude')
      expect(unpinned).toEqual(withoutFeature)
      expect(unpinned.env).toEqual({
        [POINTER]: join(f.dataRoot, 'claude-profiles', 'selected-host'),
        CLAUDE_CONFIG_DIR: f.home('a'),
        [INJECTED]: f.home('a')
      })
      expect(unpinned.claudeAuth?.provenance).toBe('profile:a')
      expect(f.prepareClaudeAuth).toHaveBeenCalledTimes(2)
    })

    it('runs a project pinned to B on B while A is active, and never prepares A', async () => {
      const f = fixture(preflight)
      await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
      const { env, claudeAuth } = await f.spawn(worktree('local'), 'claude')
      const routed = {
        [POINTER]: f.pointer('accounts', 'b'),
        CLAUDE_CONFIG_DIR: f.home('b'),
        [INJECTED]: f.home('b')
      }
      expect(env).toEqual(routed)
      expect(claudeAuth).toEqual({
        configDir: f.home('b'),
        runtime: 'host',
        wslDistro: null,
        wslLinuxConfigDir: null,
        envPatch: routed,
        provenance: 'profile:b'
      })
      expect(readFileSync(f.pointer('accounts', 'b'), 'utf8')).toBe(f.home('b'))
      expect(f.prepareClaudeAuth).not.toHaveBeenCalled()
    })

    it("removes the active account from a System default pin and gives back the user's own folder", async () => {
      for (const own of [resolve('/user/own'), undefined]) {
        const f = fixture(preflight, own ? { CLAUDE_CONFIG_DIR: own } : {})
        await f.pins.set('local', 'claude', { kind: 'system' })
        const { env, claudeAuth } = await f.spawn(worktree('local'), 'claude')
        expect(env).toEqual({
          [POINTER]: f.pointer('system'),
          ...(own ? { ORCA_CLAUDE_USER_CONFIG_DIR: own, CLAUDE_CONFIG_DIR: own } : {})
        })
        expect(claudeAuth).toEqual({
          configDir: own ?? join(f.userHome, '.claude'),
          runtime: 'host',
          wslDistro: null,
          wslLinuxConfigDir: null,
          envPatch: { [POINTER]: f.pointer('system') },
          provenance: 'system'
        })
        expect(readFileSync(f.pointer('system'), 'utf8')).toBe('')
        expect(f.prepareClaudeAuth).not.toHaveBeenCalled()
      }
    })

    it('ignores stale and WSL account pins, folder projects, folder workspaces and remote projects', async () => {
      const f = fixture(preflight)
      installProjectClaudeBinding(undefined)
      const unpinned = await f.spawn(worktree('local'), 'claude')
      installProjectClaudeBinding(f.binding)
      for (const accountId of ['gone', 'w']) {
        await f.pins.set('local', 'claude', { kind: 'account', accountId })
        expect(await f.spawn(worktree('local'), 'claude')).toEqual(unpinned)
      }
      for (const repoId of ['folder', 'ssh', 'runtime']) {
        await f.pins.set(repoId, 'claude', { kind: 'system' })
        expect(await f.spawn(worktree(repoId), 'claude')).toEqual(unpinned)
      }
      expect(await f.spawn('folder:0b0f1a62-5d6e-4b8f-9d7e-1f2a3b4c5d6e', 'claude')).toEqual(
        unpinned
      )
      await f.pins.set('local', 'claude', { kind: 'system' })
      const wt = worktree('local')
      expect(
        f.binding.resolve(store, { worktreeId: wt }, { runtime: 'wsl', wslDistro: 'Ubuntu' })
      ).toBeNull()
      // The SSH twin shares the pinned project's id but runs on its own host.
      expect(
        f.binding.resolve(store, { worktreeId: wt, connectionId: 'target-1' }, { runtime: 'host' })
      ).toBeNull()
      expect(f.binding.resolve(store, { worktreeId: wt }, { runtime: 'host' })).not.toBeNull()
    })

    it('pinned to System default, launches as System default does except for its own pointer', async () => {
      for (const own of [resolve('/user/own'), undefined]) {
        const f = fixture(preflight, own ? { CLAUDE_CONFIG_DIR: own } : {})
        f.settings.activeClaudeManagedAccountId = null
        const unpinned = await f.spawn(worktree('local'), 'claude')
        await f.pins.set('local', 'claude', { kind: 'system' })
        const pinned = await f.spawn(worktree('local'), 'claude')
        expect(withoutPointer(pinned.env)).toEqual(withoutPointer(unpinned.env))
        expect({
          ...pinned.claudeAuth,
          envPatch: withoutPointer(pinned.claudeAuth?.envPatch)
        }).toEqual({
          ...unpinned.claudeAuth,
          envPatch: withoutPointer(unpinned.claudeAuth?.envPatch)
        })
        expect(pinned.env?.[POINTER]).toBe(f.pointer('system'))
      }
    })

    it('pinned to the active account, launches as unpinned except for its own pointer', async () => {
      const f = fixture(preflight)
      const unpinned = await f.spawn(worktree('local'), 'claude')
      await f.pins.set('local', 'claude', { kind: 'account', accountId: 'a' })
      const pinned = await f.spawn(worktree('local'), 'claude')
      expect(withoutPointer(pinned.env)).toEqual(withoutPointer(unpinned.env))
      expect({
        ...pinned.claudeAuth,
        envPatch: withoutPointer(pinned.claudeAuth?.envPatch)
      }).toEqual({
        ...unpinned.claudeAuth,
        envPatch: withoutPointer(unpinned.claudeAuth?.envPatch)
      })
      expect(pinned.env?.[POINTER]).toBe(f.pointer('accounts', 'a'))
      expect(readFileSync(f.pointer('accounts', 'a'), 'utf8')).toBe(f.home('a'))
      expect(readFileSync(join(f.dataRoot, 'claude-profiles', 'selected-host'), 'utf8')).toBe(
        f.home('a')
      )
    })

    it('fails a Claude launch closed when the pinned folder cannot be set up, but still opens a shell', async () => {
      const f = fixture(preflight)
      rmSync(join(f.dataRoot, 'claude-profiles', 'b'), { recursive: true })
      f.setup.outcome = 'refused'
      await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
      await expect(f.spawn(worktree('local'), 'claude')).rejects.toMatchObject({
        reason: 'claudeAccountSetupFailed'
      })
      expect(f.prepareClaudeAuth).not.toHaveBeenCalled()
      const shell = await f.spawn(worktree('local'))
      expect(shell.claudeAuth).toBeNull()
      expect(shell.env).toEqual({
        [POINTER]: f.pointer('accounts', 'b'),
        CLAUDE_CONFIG_DIR: f.home('b'),
        [INJECTED]: f.home('b')
      })
    })
  }
)

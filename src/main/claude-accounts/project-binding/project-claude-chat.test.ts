import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { chatNamingAgentTarget } from '../../runtime/agent-session/naming/structured-chat-naming-agent-launch'
import { claudeNamingInvocation } from '../../claude/conversation-naming/claude-naming-invocation'
import { agentSessionRecordFixture } from '../../native-chat/testing/agent-session-record-test-fixture'
import type { StructuredAgentAccountHomeServices } from '../../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { structuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import { createClaudeStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { StructuredAgentLaunchSources } from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import {
  createProjectClaudeFixture,
  projectClaudeTestWorktree as worktree,
  removeProjectClaudeFixtures
} from './project-claude-binding.test-fixture'
import { installProjectClaudeBinding } from './project-claude-launch'

const POINTER = 'ORCA_CLAUDE_PROFILE_POINTER'
const SESSION_ID = 'orca-session-1'
afterEach(() => {
  vi.restoreAllMocks()
  removeProjectClaudeFixtures()
})

const location = (repoId = 'local'): AgentSessionExecutionLocation => ({
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: worktree(repoId),
  workspaceKind: 'git-worktree'
})

/** Accounts a (active), b and c; the chat runs in the project `local` unless told otherwise. */
function chatFixture() {
  const f = createProjectClaudeFixture()
  const prepareLaunch = vi.spyOn(f.router, 'prepareLaunch')
  const systemHome = join(f.userHome, '.claude')
  // The create seam: what a new chat records as its account.
  const create = async (where = location()) =>
    requireLegacyAgentSessionAccountHome(
      await structuredAgentRuntimeMetadata('claude')!.resolveAccountHome(
        { launchEnv: {}, location: where, purpose: 'launch', workspacePath: null },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Claude's account home reads only getClaudeConfigDirectory.
        {
          getClaudeConfigDirectory: () => f.router.systemDefaultHome()
        } as unknown as StructuredAgentAccountHomeServices
      )
    ).path
  // The launch seam: what a start of that chat actually runs under.
  const launch = async (where = location()) => {
    const record = agentSessionRecordFixture({
      sessionId: SESSION_ID,
      location: where,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/record/home' }
    })
    const resolve = createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async () => f.root,
      resolveInheritedEnv: async () => ({ PATH: '/usr/bin:/bin' }),
      resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      resolveLaunchArgs: () => []
    })
    const value = await resolve({
      identity: {
        sessionId: SESSION_ID,
        workspaceId: where.workspaceId,
        hostId: LOCAL_EXECUTION_HOST_ID,
        agent: 'claude',
        providerHandle: null
      }
    })
    return {
      home: value.claudeConfigDir,
      recipe: value.accountRecipe,
      account: value.account,
      configDir: value.env.CLAUDE_CONFIG_DIR,
      pointer: value.env[POINTER]
    }
  }
  return { ...f, prepareLaunch, systemHome, create, launch }
}

describe('Claude chats in a pinned project', () => {
  it('leaves an unpinned project exactly as the active account makes it', async () => {
    const f = chatFixture()
    installProjectClaudeBinding(undefined)
    const withoutFeature = { create: await f.create(), launch: await f.launch() }
    installProjectClaudeBinding(f.binding)
    expect({ create: await f.create(), launch: await f.launch() }).toEqual(withoutFeature)
    expect(withoutFeature.launch).toEqual({
      home: f.home('a'),
      recipe: { route: 'managed', accountId: 'a', home: f.home('a') },
      account: 'managed',
      configDir: f.home('a'),
      pointer: join(f.dataRoot, 'claude-profiles', 'selected-host')
    })
    expect(f.prepareLaunch).toHaveBeenCalledTimes(2)
  })

  it('creates and launches a chat in a project pinned to B on B while A is active', async () => {
    const f = chatFixture()
    await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
    expect(await f.create()).toBe(f.home('b'))
    expect(await f.launch()).toEqual({
      home: f.home('b'),
      recipe: { route: 'managed', accountId: 'b', home: f.home('b') },
      account: 'managed',
      configDir: f.home('b'),
      pointer: f.pointer('accounts', 'b')
    })
    expect(f.prepareLaunch).not.toHaveBeenCalled()
  })

  it("runs a project pinned to System default on the System default home, not A's", async () => {
    const f = chatFixture()
    await f.pins.set('local', 'claude', { kind: 'system' })
    expect(await f.create()).toBe(f.systemHome)
    expect(await f.launch()).toEqual({
      home: f.systemHome,
      recipe: { route: 'system', home: f.systemHome, configDir: null },
      account: 'system',
      configDir: undefined,
      pointer: f.pointer('system')
    })
    expect(f.prepareLaunch).not.toHaveBeenCalled()
  })

  it('treats stale, WSL-account and remote pins as unpinned', async () => {
    const f = chatFixture()
    const unpinned = { create: await f.create(), launch: await f.launch() }
    for (const accountId of ['gone', 'w']) {
      await f.pins.set('local', 'claude', { kind: 'account', accountId })
      expect({ create: await f.create(), launch: await f.launch() }).toEqual(unpinned)
    }
    await f.pins.set('ssh', 'claude', { kind: 'system' })
    expect(await f.launch(location('ssh'))).toEqual(unpinned.launch)
    await f.pins.set('local', 'claude', { kind: 'system' })
    // A WSL chat has its own router; the same project there keeps the active account.
    expect(f.binding.pinForLocation({ ...location(), wslDistro: 'Ubuntu' })).toBeNull()
    expect(f.binding.pinForLocation(null)).toBeNull()
  })

  it('names a chat with the pinned account, as its launch runs', async () => {
    const f = chatFixture()
    await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
    const record = agentSessionRecordFixture({
      sessionId: SESSION_ID,
      location: location(),
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: f.home('a') }
    })
    const target = await chatNamingAgentTarget(record, f.root, async () => ({}), undefined)
    expect(target).toMatchObject({ env: { CLAUDE_CONFIG_DIR: f.home('b') } })
    const naming = await claudeNamingInvocation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming reads only these two sources and the optional ones it guards.
      {
        resolveBaseEnvironment: async () => ({ PATH: '/usr/bin:/bin' }),
        resolveWorkspacePath: async () => f.root
      } as unknown as StructuredAgentLaunchSources,
      () => [],
      () => ({ command: '/usr/local/bin/claude', prefixArgs: [] })
    )(record)
    expect(naming.home).toBe(f.home('b'))
    expect(naming.env[POINTER]).toBe(f.pointer('accounts', 'b'))
    expect(f.prepareLaunch).not.toHaveBeenCalled()
  })
})

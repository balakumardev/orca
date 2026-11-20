import { join } from 'node:path'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocalAgentRuntimeTarget } from '../../ipc/filesystem/filesystem-source-control-ai-targets'
import { generationWorkspaceOfLocalPath } from '../../project-agent-accounts/project-agent-account-generation-target'
import type { RuntimeGitTarget } from '../../runtime/integrations/git/runtime-git-command-target'
import { localAgentRuntimeTargetForTarget } from '../../runtime/integrations/git/runtime-git-generation-context'
import { resolveGenerationTarget } from '../../agent-hooks/first-work/first-work-generation-target'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
import {
  createProjectClaudeFixture,
  projectClaudeTestStore,
  projectClaudeTestWorktree as worktree,
  removeProjectClaudeFixtures
} from './project-claude-binding.test-fixture'
import { withPlatform } from '../../text-generation/commit-message-text-generation-test-harness'
import {
  projectClaudeGenerationTarget,
  projectClaudeTerminalPreparation
} from './project-claude-workspace'

const POINTER = 'ORCA_CLAUDE_PROFILE_POINTER'
const INJECTED = 'ORCA_CLAUDE_INJECTED_CONFIG_DIR'
afterEach(removeProjectClaudeFixtures)

function generationFixture() {
  const f = createProjectClaudeFixture()
  const prepareForClaudeLaunch = vi.fn(() => f.router.prepareLaunch())
  const env = async (target: Parameters<typeof prepareLocalCommitMessageAgentEnv>[2]) => {
    const prepared = await prepareLocalCommitMessageAgentEnv(
      'claude',
      { prepareForClaudeLaunch, resolveBaseEnvironment: async () => ({ PATH: '/usr/bin' }) },
      target
    )
    return prepared.ok ? prepared.env : prepared.error
  }
  return { ...f, prepareForClaudeLaunch, env }
}

const runtimeTarget = (executionHostId: RuntimeGitTarget['executionHostId']) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the account target reads only the worktree id, the host and its git options.
  ({ worktree: { id: worktree('local') }, executionHostId }) as unknown as RuntimeGitTarget

describe('commit and PR text in a pinned project', () => {
  it('sends the diff of a project pinned to B through B while A is active', async () => {
    const f = generationFixture()
    await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
    const onB = {
      PATH: '/usr/bin',
      [POINTER]: f.pointer('accounts', 'b'),
      CLAUDE_CONFIG_DIR: f.home('b'),
      [INJECTED]: f.home('b')
    }
    // The desktop's own IPC finds the project from the path it was asked about.
    const ipcWorkspace = generationWorkspaceOfLocalPath(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only the repos and the worktree metadata.
      projectClaudeTestStore as unknown as RuntimeStore,
      '/projects/local',
      '/projects/local'
    )
    expect(await f.env(getLocalAgentRuntimeTarget({}, ipcWorkspace))).toEqual(onB)
    // A paired client asks the runtime, which names the workspace itself.
    expect(await f.env(localAgentRuntimeTargetForTarget(runtimeTarget('local')))).toEqual(onB)
    expect(f.prepareForClaudeLaunch).not.toHaveBeenCalled()
  })

  it('leaves unpinned projects, remote targets and WSL on the active account', async () => {
    const f = generationFixture()
    const onA = {
      PATH: '/usr/bin',
      [POINTER]: join(f.dataRoot, 'claude-profiles', 'selected-host'),
      CLAUDE_CONFIG_DIR: f.home('a'),
      [INJECTED]: f.home('a')
    }
    expect(await f.env({ runtime: 'host', workspaceId: worktree('local') })).toEqual(onA)
    await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
    expect(await f.env(localAgentRuntimeTargetForTarget(runtimeTarget('ssh:target-1')))).toEqual(
      onA
    )
    await f.env({ runtime: 'wsl', wslDistro: 'Ubuntu', workspaceId: worktree('local') })
    expect(f.prepareForClaudeLaunch).toHaveBeenCalledTimes(3)
  })
})

describe('orca claude-teams in a pinned project', () => {
  it("prepares the leader of a local terminal on the project's account, never a WSL or SSH one", async () => {
    const f = generationFixture()
    await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
    const pty = { worktreeId: worktree('local'), connectionId: null, isWsl: false, wslDistro: null }
    expect(await projectClaudeTerminalPreparation(pty)).toMatchObject({
      configDir: f.home('b'),
      provenance: 'profile:b'
    })
    expect(
      projectClaudeTerminalPreparation({ ...pty, isWsl: true, wslDistro: 'Ubuntu' })
    ).toBeNull()
    expect(projectClaudeTerminalPreparation({ ...pty, connectionId: 'target-1' })).toBeNull()
    expect(projectClaudeTerminalPreparation({ ...pty, worktreeInferredFromCwd: true })).toBeNull()
    expect(projectClaudeTerminalPreparation(undefined)).toBeNull()
  })
})

describe('first-work branch names in a pinned project', () => {
  it("names a pinned project's branch through the pinned account and leaves the rest alone", async () => {
    const f = generationFixture()
    const prepareForCodexLaunch = vi.fn(() => null)
    const deps = {
      getAgentEnvResolvers: () => ({
        prepareForClaudeLaunch: f.prepareForClaudeLaunch,
        prepareForCodexLaunch,
        resolveBaseEnvironment: async () => ({ PATH: '/usr/bin' })
      })
    }
    const cwd = '/projects/local/wt'
    const unpinned = await resolveGenerationTarget(cwd, 'claude', deps, worktree('local'))
    expect(unpinned).toMatchObject({ env: { CLAUDE_CONFIG_DIR: f.home('a') } })
    await f.pins.set('local', 'claude', { kind: 'account', accountId: 'b' })
    expect(await resolveGenerationTarget(cwd, 'claude', deps, worktree('local'))).toEqual({
      kind: 'local',
      cwd,
      env: {
        PATH: '/usr/bin',
        [POINTER]: f.pointer('accounts', 'b'),
        CLAUDE_CONFIG_DIR: f.home('b'),
        [INJECTED]: f.home('b')
      }
    })
    expect(f.prepareForClaudeLaunch).toHaveBeenCalledTimes(1)
    // A chat named by a configured Claude agent follows the chat's own location.
    const chat: AgentSessionExecutionLocation = {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: worktree('local'),
      workspaceKind: 'git-worktree'
    }
    expect(await resolveGenerationTarget(cwd, 'claude', deps, chat)).toMatchObject({
      env: { CLAUDE_CONFIG_DIR: f.home('b') }
    })
    await resolveGenerationTarget(cwd, 'claude', deps, { ...chat, wslDistro: 'Ubuntu' })
    await resolveGenerationTarget(cwd, 'claude', deps, { ...chat, executionHostId: 'ssh:target-1' })
    expect(f.prepareForClaudeLaunch).toHaveBeenCalledTimes(3)
    // On Windows a project under a WSL path names its branch in that distro, on the distro's accounts.
    // The target is chosen before the first await, so the platform holds for that choice.
    const wslCwd = '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt'
    await withPlatform('win32', () =>
      resolveGenerationTarget(wslCwd, 'claude', deps, worktree('local'))
    )
    expect(f.prepareForClaudeLaunch).toHaveBeenCalledTimes(4)
    expect(
      withPlatform('win32', () =>
        projectClaudeGenerationTarget('claude', worktree('local'), 'C:\\wt')
      )
    ).toEqual({
      workspaceId: worktree('local')
    })
    // The Claude pin is not Codex's, so a Codex branch name keeps the call it makes today.
    await resolveGenerationTarget(cwd, 'codex', deps, worktree('local'))
    expect(prepareForCodexLaunch).toHaveBeenCalledWith(undefined)
  })
})

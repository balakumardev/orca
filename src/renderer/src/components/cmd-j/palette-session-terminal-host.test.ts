// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { launchAiVaultSessionInNewTab } from '@/lib/agent-session/resume/history/launch-ai-vault-session'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation'
import { buildAiVaultResumeStartupForWorktree } from '@/lib/agent-session/resume/history/ai-vault-resume-command'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'

const initialState = useAppStore.getInitialState()
beforeEach(() => Object.defineProperty(window, 'api', { configurable: true, value: { gh: {} } }))
afterEach(() => useAppStore.setState(initialState, true))

describe('terminal history owner', () => {
  it('composes a remote resume without borrowing desktop commands or environment defaults', () => {
    const startup = buildAiVaultResumeStartupForWorktree({
      state: {
        ...initialState,
        settings: createGlobalSettingsFixture({
          agentCmdOverrides: { claude: 'desktop-claude' },
          agentDefaultArgs: { claude: '--model desktop-model' },
          agentDefaultEnv: { claude: { DESKTOP_ONLY: 'desktop-value' } }
        })
      },
      session: {
        agent: 'claude',
        sessionId: 'billing-conversation',
        cwd: null,
        codexHome: null,
        executionHostId: 'runtime:intbox',
        executionHostPlatform: 'linux'
      },
      launchSettings: {
        agentDefaultArgs: { claude: '--model remote-model' },
        agentPermissionDefault: 'own'
      }
    })

    expect(startup.command).not.toContain('desktop-claude')
    expect(startup.launchConfig?.agentArgs).toBe('--model remote-model')
    expect(startup.env).toEqual({})
  })

  it('does not send a preparing resume after the captured host retires', async () => {
    const preparing = Promise.withResolvers<void>()
    const prepared = Promise.withResolvers<{ command: string }>()
    let current = true
    const createdOn: string[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        gh: {},
        runtimeEnvironments: {
          call: async (request: { selector: string }) => {
            createdOn.push(request.selector)
            return {
              id: 'request',
              ok: false,
              error: { code: 'forbidden', message: 'creation refused' }
            }
          }
        }
      }
    })
    const launch = createWebRuntimeSessionTerminalResult({
      environmentId: 'intbox',
      worktreeId: 'remote-workspace',
      launchAgent: 'claude',
      preparedAgentCommand: true,
      agentSessionKind: 'resume',
      selectWorktree: false,
      isCurrent: () => current,
      legacyAgentLaunch: () => {
        preparing.resolve()
        return prepared.promise
      }
    })
    await preparing.promise
    current = false
    prepared.resolve({ command: 'claude --resume billing-conversation' })

    expect((await launch).outcome.status).toBe('failed')
    expect(createdOn).toEqual([])
  })

  it('resumes a local recording in the local workspace copy while its remote twin is selected', () => {
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: 'same-workspace',
        activeWorkspaceExecutionHostId: 'runtime:intbox',
        repos: [makeRepo(), { ...makeRepo(), executionHostId: 'runtime:intbox' }],
        worktreesByRepo: {
          'repo-1': [
            makeWorktree('same-workspace', 'Local', { hostId: 'local' }),
            makeWorktree('same-workspace', 'Remote', {
              hostId: 'runtime:intbox',
              runtimeOwnerEnvironmentId: 'intbox'
            })
          ]
        }
      },
      true
    )
    const launch = launchAiVaultSessionInNewTab({
      agent: 'claude',
      worktreeId: 'same-workspace',
      executionHostId: 'local',
      command: 'claude --resume billing-conversation'
    })

    expect(launch.tabId).not.toBeNull()
    const state = useAppStore.getState()
    expect(state.activeWorkspaceExecutionHostId).toBe('local')
    expect(
      state.unifiedTabsByWorktree['same-workspace']?.map((tab) => tab.executionHostId)
    ).toEqual(['local'])
    expect(state.pendingStartupByTabId[launch.tabId!]?.command).toBe(
      'claude --resume billing-conversation'
    )
  })
})

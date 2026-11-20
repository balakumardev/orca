// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { resumeAiVaultSessionInNewChat } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-launch'
import type { AiVaultPrepareSessionResumeArgs } from '../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { paletteSessionOfHit } from './palette-session-facts'
import { sessionHit } from './palette-session-hit.test-fixture'

const initialState = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initialState, true))

function workspaceCopies() {
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: 'shared-workspace',
      activeWorkspaceExecutionHostId: 'local',
      repos: [makeRepo(), { ...makeRepo(), executionHostId: 'runtime:intbox' }],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree('shared-workspace', 'Local', { hostId: 'local' }),
          makeWorktree('shared-workspace', 'Remote', {
            hostId: 'runtime:intbox',
            runtimeOwnerEnvironmentId: 'intbox'
          })
        ]
      }
    },
    true
  )
}

const recording = {
  ...paletteSessionOfHit(
    sessionHit('conversation', { agent: 'codex', executionHostId: 'runtime:intbox' })
  ),
  codexHome: '/home/orca/codex-runtime-home/home'
}

describe('chat resume recording authority', () => {
  it('prepares the remote recording while its same-ID local workspace is selected', async () => {
    workspaceCopies()
    const prepared: string[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        aiVault: {
          prepareSessionResume: async (request: AiVaultPrepareSessionResumeArgs) => {
            prepared.push(request.executionHostId ?? 'local')
            throw new Error('host refused preparation')
          }
        }
      }
    })

    await resumeAiVaultSessionInNewChat(
      recording,
      'codex',
      'shared-workspace',
      'resume-1',
      undefined,
      {
        executionHostId: 'runtime:intbox',
        isCurrent: () => true
      }
    )

    expect(prepared).toEqual(['runtime:intbox'])
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')
  })

  it('does not prepare a recording whose captured host has already retired', async () => {
    workspaceCopies()
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:intbox' })
    const prepared: AiVaultPrepareSessionResumeArgs[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        aiVault: {
          prepareSessionResume: async (request: AiVaultPrepareSessionResumeArgs) => {
            prepared.push(request)
            throw new Error('retired host must not be touched')
          }
        }
      }
    })

    await resumeAiVaultSessionInNewChat(
      recording,
      'codex',
      'shared-workspace',
      'resume-2',
      undefined,
      {
        executionHostId: 'runtime:intbox',
        isCurrent: () => false
      }
    )

    expect(prepared).toEqual([])
  })
})

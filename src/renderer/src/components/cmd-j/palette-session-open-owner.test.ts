// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  makeGroup,
  makeRepo,
  makeUnifiedTab,
  makeWorktree
} from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { openPaletteSession } from './palette-session-open'
import { sessionHit } from './palette-session-hit.test-fixture'

const initialState = useAppStore.getInitialState()
const initialApi = window.api
afterEach(() => {
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: initialApi })
})

describe('palette opens the recording workspace', () => {
  it('opens the local native chat while the same-ID remote workspace is selected', async () => {
    const workspaceId = 'repo-1::/code/acme'
    const activatedOwners: string[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        gh: {},
        runtime: {
          call: async (request: { method: string }) => {
            if (request.method === 'session.tabs.activate') {
              activatedOwners.push('local')
            }
            return { id: 'request', ok: true, result: {} }
          }
        },
        runtimeEnvironments: {
          call: async () => {
            activatedOwners.push('remote')
            return { id: 'request', ok: true, result: {} }
          }
        }
      }
    })
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: workspaceId,
        activeWorkspaceExecutionHostId: 'runtime:intbox',
        repos: [makeRepo(), { ...makeRepo(), executionHostId: 'runtime:intbox' }],
        worktreesByRepo: {
          'repo-1': [
            makeWorktree(workspaceId, 'Local', { hostId: 'local', path: '/code/acme' }),
            makeWorktree(workspaceId, 'Remote', {
              hostId: 'runtime:intbox',
              runtimeOwnerEnvironmentId: 'intbox',
              path: '/code/acme'
            })
          ]
        },
        unifiedTabsByWorktree: {
          [workspaceId]: [
            {
              ...makeUnifiedTab('local-chat', workspaceId, 'chat-1', 'Local'),
              contentType: 'agent-session',
              executionHostId: 'local'
            },
            {
              ...makeUnifiedTab('remote-chat', workspaceId, 'chat-1', 'Remote'),
              contentType: 'agent-session',
              executionHostId: 'runtime:intbox'
            }
          ]
        },
        groupsByWorktree: { [workspaceId]: [makeGroup(workspaceId, ['local-chat', 'remote-chat'])] }
      },
      true
    )

    await openPaletteSession(
      sessionHit('recording', {
        structuredSession: { workspaceId, sessionId: 'chat-1' }
      })
    )

    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')
    expect(useAppStore.getState().getActiveTab(workspaceId)?.id).toBe('local-chat')
    expect(activatedOwners).toEqual(['local'])
  })
})

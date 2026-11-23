// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { findOriginalAiVaultSessionPane } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-original-pane'
import {
  LEAF_ID,
  makeAgentEntry,
  makeFolderWorkspace,
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { paletteSessionOfHit, readPaletteSessionFacts } from './palette-session-facts'
import { sessionHit } from './palette-session-hit.test-fixture'
import { buildSessionPaletteResults } from './palette-session-results'

const initialState = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initialState, true))

describe('palette session recording hosts', () => {
  it('finds a remote folder workspace whose owner is inherited from its project group', () => {
    useAppStore.setState(
      {
        ...initialState,
        projectGroups: [
          {
            id: 'remote-group',
            name: 'Intbox',
            parentPath: '/code',
            parentGroupId: null,
            executionHostId: 'runtime:intbox',
            createdFrom: 'manual',
            tabOrder: 0,
            isCollapsed: false,
            color: null,
            createdAt: 0,
            updatedAt: 0
          }
        ],
        folderWorkspaces: [
          makeFolderWorkspace({
            id: 'remote-folder',
            projectGroupId: 'remote-group',
            folderPath: '/code/acme-web'
          })
        ]
      },
      true
    )

    expect(
      readPaletteSessionFacts(
        useAppStore.getState(),
        sessionHit('same', {
          executionHostId: 'runtime:intbox'
        })
      ).ownerWorkspaceId
    ).toBe('folder:remote-folder')
  })

  it('keeps identical local and remote recordings independently selectable', () => {
    const owners: string[] = []
    const rows = buildSessionPaletteResults(
      [sessionHit('same'), sessionHit('same', { executionHostId: 'runtime:intbox' })],
      'billing',
      {
        untitled: 'Untitled',
        isInert: () => false,
        decorate: () => ({}),
        onOpen: (hit) => owners.push(paletteSessionOfHit(hit).executionHostId)
      }
    )
    rows.forEach((row) => row.onSelect())
    expect(owners).toEqual(['local', 'runtime:intbox'])
  })

  it('selects the recording host workspace when both computers have the same directory', () => {
    useAppStore.setState(
      {
        ...initialState,
        repos: [makeRepo()],
        worktreesByRepo: {
          'repo-1': [
            makeWorktree('local-workspace', 'Local', { path: '/code/acme-web' }),
            makeWorktree('remote-workspace', 'Remote', {
              path: '/code/acme-web',
              hostId: 'runtime:intbox',
              runtimeOwnerEnvironmentId: 'intbox'
            })
          ]
        }
      },
      true
    )
    const facts = readPaletteSessionFacts(
      useAppStore.getState(),
      sessionHit('same', { executionHostId: 'runtime:intbox' })
    )
    expect(facts.ownerWorkspaceId).toBe('remote-workspace')
  })

  it('does not reveal a local pane for a remote recording with the same provider ID', () => {
    const local = makeAgentEntry('local-tab', 'working', 1, {
      worktreeId: 'local-workspace',
      tabId: 'local-tab',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'same' }
    })
    const state = {
      ...initialState,
      repos: [makeRepo()],
      worktreesByRepo: {
        'repo-1': [makeWorktree('local-workspace', 'Local', { path: '/code/acme-web' })]
      },
      agentStatusByPaneKey: acceptedAgentStatuses([[local.paneKey, local]]),
      tabsByWorktree: {
        'local-workspace': [makeTerminalTab('local-tab', 'local-workspace', 'Conversation')]
      },
      terminalLayoutsByTabId: {
        'local-tab': {
          root: { type: 'leaf' as const, leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'local-pty' }
        }
      }
    }
    const recording = {
      ...paletteSessionOfHit(sessionHit('same')),
      executionHostId: 'runtime:intbox' as const
    }
    expect(findOriginalAiVaultSessionPane(state, recording)).toBeNull()
  })
})

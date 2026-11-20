// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  beginProjectNameStep,
  endProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import { usePaletteProjectCreateSource } from '@/components/cmd-j/use-palette-project-create-source'
import { readProjectScopedCreate } from '@/components/cmd-j/palette-project-create-composer'
import { useWorktreeJumpPaletteNameStep } from './use-worktree-jump-palette-name-step'
import { useWorktreeJumpPaletteProjectCreateShortcut } from './use-worktree-jump-palette-project-create-shortcut'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  initialAppState,
  keyEvent,
  replaceProjectCreateRuntime,
  seedHostCollisionProjects
} from './worktree-jump-palette-project-create-test-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

// Target fixtures omit rendering-only fields from the real palette row.
type TargetRow = Pick<PaletteListEntry, 'id' | 'type'> & Record<string, unknown>
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shortcut reads only the target fields populated here, not the row's ranking or rendering fields.
const entry = (value: TargetRow): PaletteListEntry => value as PaletteListEntry

function mountCreation(
  entry?: PaletteListEntry,
  activeWorkspaceExecutionHostId: ExecutionHostId = 'runtime:server-a'
) {
  const state = useAppStore.getState()
  const workspaces = Object.values(state.worktreesByRepo).flat()
  return renderHook(() => ({
    shortcut: useWorktreeJumpPaletteProjectCreateShortcut({
      activeWorktreeId: 'workspace-twin',
      activeWorkspaceExecutionHostId,
      commandSelectedItemId: entry?.id ?? '',
      listEntries: entry ? [entry] : [],
      listEntryRenderKeys: entry ? [entry.id] : [],
      liveQueryRef: { current: 'acme-web' },
      paletteSearchQuery: 'acme-web',
      repos: state.repos,
      workspaces,
      taskSourceUrl: null
    }),
    nameStep: useWorktreeJumpPaletteNameStep({
      visible: true,
      query: 'acme-web',
      closeModal: useAppStore.getState().closeModal,
      handleOpenChange: vi.fn(),
      handleQueryChange: vi.fn(),
      setSelectedItemId: vi.fn(),
      skipRestoreFocusRef: { current: false }
    }),
    source: usePaletteProjectCreateSource({ query: 'acme', visible: true })
  }))
}

async function submitName(hook: ReturnType<typeof mountCreation>) {
  act(() => hook.result.current.nameStep.inputProps.onValueChange?.('remote-fix'))
  await act(async () =>
    hook.result.current.nameStep.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
  )
  expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  expect(useAppStore.getState().modalData).toEqual({
    initialRepoId: 'repo-acme-web',
    initialWorkspaceTarget: {
      projectId: 'project-web',
      hostId: 'runtime:server-a',
      projectHostSetupId: 'setup-remote'
    },
    prefilledName: 'remote-fix',
    autoSubmit: true,
    autoSubmitHost: expect.objectContaining({
      executionHostId: 'runtime:server-a',
      pairingRevision: 1,
      runtimeId: 'runtime-server-a',
      connectionGeneration: 1
    }),
    telemetrySource: 'command_palette'
  })
}

describe('Cmd+J creation entry points retain their execution host', () => {
  beforeEach(seedHostCollisionProjects)
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    useAppStore.setState(initialAppState, true)
  })

  it('uses the runtime owner of a highlighted workspace instead of its physical local host', async () => {
    const worktree = useAppStore.getState().worktreesByRepo['repo-acme-web'][1]
    const hook = mountCreation(entry({ id: 'remote-workspace', type: 'worktree', worktree }))
    act(() => hook.result.current.shortcut.handleKeyDown(keyEvent()))
    await submitName(hook)
  })

  it('keeps a highlighted tab on the remote workspace when its id also exists locally', async () => {
    const hook = mountCreation(
      entry({
        id: 'remote-tab',
        type: 'workspace-tab',
        result: { worktreeId: 'workspace-twin', executionHostId: 'runtime:server-a' }
      })
    )
    act(() => hook.result.current.shortcut.handleKeyDown(keyEvent()))
    await submitName(hook)
  })

  it('uses the active remote workspace for the shifted shortcut', async () => {
    const hook = mountCreation()
    act(() => hook.result.current.shortcut.handleKeyDown(keyEvent({ shiftKey: true })))
    await submitName(hook)
  })

  it('keeps the active local workspace local when a runtime-owned twin appears first', async () => {
    useAppStore.setState({
      worktreesByRepo: {
        'repo-acme-web': useAppStore.getState().worktreesByRepo['repo-acme-web'].toReversed()
      }
    })
    const hook = mountCreation(undefined, 'local')
    act(() => hook.result.current.shortcut.handleKeyDown(keyEvent({ shiftKey: true })))
    act(() => hook.result.current.nameStep.inputProps.onValueChange?.('local-fix'))
    await act(async () =>
      hook.result.current.nameStep.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
    )

    expect(useAppStore.getState().modalData).toEqual({
      initialRepoId: 'repo-acme-web',
      initialWorkspaceTarget: {
        projectId: 'project-local',
        hostId: 'local',
        projectHostSetupId: 'setup-local'
      },
      prefilledName: 'local-fix',
      autoSubmit: true,
      telemetrySource: 'command_palette'
    })
  })

  it('keeps the selected project row on its own host', async () => {
    const repo = useAppStore.getState().repos[1]
    const hook = mountCreation(
      entry({
        id: 'remote-project',
        type: 'project-target',
        result: { kind: 'project', repo }
      })
    )
    act(() => hook.result.current.shortcut.handleKeyDown(keyEvent()))
    await submitName(hook)
  })

  it('keeps local and remote new-worktree rows independently selectable', async () => {
    const hook = mountCreation()
    const rows = hook.result.current.source?.results ?? []
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    const remote = rows.find((row) => row.title === 'New worktree in acme-web')
    act(() => remote?.onSelect())
    await submitName(hook)
  })

  it('carries the remote setup through a project/name query with a colliding local repo id', async () => {
    const hook = mountCreation()
    const target = readProjectScopedCreate('acme-web/remote-fix')
    if (!target) {
      throw new Error('remote project was not resolved')
    }
    act(() => beginProjectNameStep(target))
    await submitName(hook)
  })

  it('refuses a saved create-row selection after a ready replacement takes the same host and repo ids', () => {
    const hook = mountCreation()
    const row = hook.result.current.source?.results.find(
      (candidate) => candidate.projectCreateTarget?.workspaceTarget.hostId === 'runtime:server-a'
    )
    if (!row) {
      throw new Error('remote create row was not offered')
    }
    const selectOriginalRow = row.onSelect
    act(replaceProjectCreateRuntime)
    act(selectOriginalRow)

    expect(hook.result.current.nameStep.step).toBeNull()
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it('refuses a shortcut on an old create row even when its keyboard handler was refreshed', () => {
    const offered = mountCreation()
    const row = offered.result.current.source?.results.find(
      (candidate) => candidate.projectCreateTarget?.workspaceTarget.hostId === 'runtime:server-a'
    )
    if (!row) {
      throw new Error('remote create row was not offered')
    }
    act(replaceProjectCreateRuntime)
    const hook = mountCreation(
      entry({ id: row.id, type: 'extra', sourceId: 'project-create', result: row })
    )
    act(() => hook.result.current.shortcut.handleKeyDown(keyEvent()))

    expect(hook.result.current.nameStep.step).toBeNull()
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it.each([false, true])(
    'refuses a saved shortcut after authority replacement (shift=%s)',
    (shiftKey) => {
      const worktree = useAppStore.getState().worktreesByRepo['repo-acme-web'][1]
      const hook = mountCreation(entry({ id: 'remote-workspace', type: 'worktree', worktree }))
      const originalShortcut = hook.result.current.shortcut.handleKeyDown
      act(replaceProjectCreateRuntime)
      act(() => originalShortcut(keyEvent({ shiftKey })))

      expect(hook.result.current.nameStep.step).toBeNull()
      expect(useAppStore.getState().activeModal).toBe('worktree-palette')
    }
  )
})

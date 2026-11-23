// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { paletteRuntimeStatus } from '@/components/cmd-j/palette-runtime-host.test-fixture'
import {
  beginProjectNameStep,
  endProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import { useWorktreeJumpPaletteNameStep } from './use-worktree-jump-palette-name-step'
import {
  initialAppState,
  keyEvent,
  project,
  seedHostCollisionProjects
} from './worktree-jump-palette-project-create-test-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function openRemoteNameStep() {
  const hook = renderHook(() =>
    useWorktreeJumpPaletteNameStep({
      visible: true,
      query: 'acme-web',
      closeModal: useAppStore.getState().closeModal,
      handleOpenChange: vi.fn(),
      handleQueryChange: vi.fn(),
      setSelectedItemId: vi.fn(),
      skipRestoreFocusRef: { current: false }
    })
  )
  const selection = {
    repoId: 'repo-acme-web',
    projectLabel: 'acme-web',
    name: 'remote-fix',
    workspaceTarget: {
      projectId: 'project-web',
      hostId: 'runtime:server-a' as const,
      projectHostSetupId: 'setup-remote'
    }
  }
  act(() => beginProjectNameStep(selection))
  return hook
}

describe('Cmd+J name-step execution target', () => {
  beforeEach(seedHostCollisionProjects)
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    useAppStore.setState(initialAppState, true)
  })

  it('hands the selected remote setup to the composer despite a local repo with the same id and path', async () => {
    const hook = openRemoteNameStep()
    await act(async () =>
      hook.result.current.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
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
  })

  it('returns to search when the chosen host disappears instead of submitting the local twin', async () => {
    const hook = openRemoteNameStep()
    useAppStore.setState({ repos: [project('acme-web')] })
    await act(async () =>
      hook.result.current.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
    )

    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
    expect(hook.result.current.inputProps.value).toBeUndefined()
  })

  it('returns to search if the selected server is re-paired while its old repo snapshot remains', async () => {
    const hook = openRemoteNameStep()
    useAppStore.setState({
      runtimeEnvironments: useAppStore.getState().runtimeEnvironments.map((environment) => ({
        ...environment,
        pairingRevision: 2
      }))
    })
    await act(async () =>
      hook.result.current.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
    )

    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
    expect(hook.result.current.inputProps.value).toBeUndefined()
  })

  it('does not revive a saved name step after the same runtime reconnects', async () => {
    const hook = openRemoteNameStep()
    const environment = useAppStore.getState().runtimeEnvironments[0]
    // Same-runtime recovery advances contact epoch while retaining the mirror generation.
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [environment.id, { ...paletteRuntimeStatus(environment), hostContactEpoch: 1 }]
      ])
    })
    await act(async () =>
      hook.result.current.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
    )

    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
    expect(hook.result.current.inputProps.value).toBeUndefined()
  })

  it('retains the explicitly selected host when another live pairing names the same server', async () => {
    const state = useAppStore.getState()
    const alias = { ...state.runtimeEnvironments[0], id: 'server-alias' }
    useAppStore.setState({
      runtimeEnvironments: [alias, ...state.runtimeEnvironments],
      runtimeStatusByEnvironmentId: new Map([
        ['server-alias', paletteRuntimeStatus(alias)],
        ...state.runtimeStatusByEnvironmentId
      ])
    })
    const hook = openRemoteNameStep()
    await act(async () =>
      hook.result.current.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
    )

    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toMatchObject({
      initialWorkspaceTarget: {
        projectId: 'project-web',
        hostId: 'runtime:server-a',
        projectHostSetupId: 'setup-remote'
      }
    })
  })
})

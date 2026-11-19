// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeRepo } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { endProjectNameStep, getProjectNameStep } from './palette-project-name-step-store'
import {
  paletteRuntimeEnvironment,
  paletteRuntimeStatus
} from './palette-runtime-host.test-fixture'
import { usePaletteFolderSource } from './use-palette-folder-source'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/onboarding/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: vi.fn(async () => ({}))
}))

const initial = useAppStore.getInitialState()
const server = paletteRuntimeEnvironment()
const folder = { path: '/code/app', kind: 'git-root' as const }

beforeEach(() => {
  useAppStore.setState(
    {
      ...initial,
      activeModal: 'worktree-palette',
      runtimeEnvironments: [server],
      runtimeStatusByEnvironmentId: new Map([['builder', paletteRuntimeStatus(server)]]),
      repos: [],
      projects: [],
      projectHostSetups: [],
      fetchWorktrees: vi.fn().mockResolvedValue(true),
      addRepoPath: async (path, _kind, target) => {
        const repo = {
          ...makeRepo(),
          path,
          executionHostId: target?.runtimeEnvironmentId
            ? ('runtime:builder' as const)
            : ('local' as const)
        }
        useAppStore.setState({ repos: [...useAppStore.getState().repos, repo] })
        return repo
      }
    },
    true
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      folderSearch: {
        list: async () => ({ entries: [folder], truncated: false }),
        resolve: async () => folder
      }
    }
  })
})

afterEach(() => {
  cleanup()
  endProjectNameStep()
  useAppStore.setState(initial, true)
  Reflect.deleteProperty(window, 'api')
})

describe('Cmd+J folders on connected hosts', () => {
  it('keeps identical paths distinct and creates the selected project on its server', async () => {
    const { result } = renderHook(() => usePaletteFolderSource({ query: 'app', visible: true }))
    await waitFor(() => expect(result.current?.results).toHaveLength(2))
    const rows = result.current!.results
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)

    await act(async () => rows.find((row) => row.id.includes('runtime:builder'))!.onModEnter?.())
    await waitFor(() =>
      expect(getProjectNameStep()).toMatchObject({
        projectPath: '/code/app',
        workspaceTarget: { hostId: 'runtime:builder' }
      })
    )
    expect(useAppStore.getState().repos.map((repo) => repo.executionHostId)).toEqual([
      'runtime:builder'
    ])
  })

  it('applies a host filter before producing folder choices', async () => {
    const { result } = renderHook(() =>
      usePaletteFolderSource({ query: 'app', visible: true, hostIds: ['runtime:builder'] })
    )
    await waitFor(() => expect(result.current?.results).toHaveLength(1))
    await act(async () => result.current!.results[0].onModEnter?.())
    await waitFor(() =>
      expect(getProjectNameStep()).toMatchObject({ workspaceTarget: { hostId: 'runtime:builder' } })
    )
  })

  it('does not open a saved row after the server pairing has been replaced', async () => {
    const { result } = renderHook(() =>
      usePaletteFolderSource({ query: 'app', visible: true, hostIds: ['runtime:builder'] })
    )
    await waitFor(() => expect(result.current?.results).toHaveLength(1))
    const oldRow = result.current!.results[0]
    const replacement = { ...server, pairingRevision: 2 }
    act(() => {
      useAppStore.setState({
        runtimeEnvironments: [replacement],
        runtimeStatusByEnvironmentId: new Map([['builder', paletteRuntimeStatus(replacement)]])
      })
    })
    await act(async () => oldRow.onModEnter?.())
    expect(useAppStore.getState().repos).toEqual([])
    expect(getProjectNameStep()).toBeNull()
  })
})

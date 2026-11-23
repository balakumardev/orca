// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { createGlobalSettingsFixture } from '../../../../shared/settings/global-settings-test-fixture'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/naming/retired-name-registry'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { retryBackgroundWorktreeCreation } from '@/lib/workspace/creation/worktree-creation-flow'
import { openProjectComposer } from '../cmd-j/palette-project-create-composer'
import {
  initialAppState,
  replaceProjectCreateRuntime,
  seedHostCollisionProjects
} from '../worktree-jump/worktree-jump-palette-project-create-test-fixtures'
import NewWorkspaceComposerModal from './composer/NewWorkspaceComposerModal'

// Presentation is irrelevant to the modal's real auto-submit and creation flow.
vi.mock('./composer/NewWorkspaceComposerCard', () => ({ default: () => null }))
vi.mock('../agent/AgentSettingsDialog', () => ({ default: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

let originalApi: PropertyDescriptor | undefined
beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  seedHostCollisionProjects()
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ defaultTuiAgent: 'blank' }),
    prefetchWorkItems: vi.fn(async () => {})
  })
  replaceRuntimeEnvironmentRevisions(useAppStore.getState().runtimeEnvironments)
})
afterEach(() => {
  cleanup()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState(initialAppState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('keeps a hidden create and its Retry bound to the pairing selected before background preparation', async () => {
  const release = Promise.withResolvers<void>()
  let preparingCreationId: string | undefined
  const mutationHosts: string[] = []
  const noHooks = { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
  const call: Window['api']['runtimeEnvironments']['call'] = async (args) => {
    const environment = useAppStore.getState().runtimeEnvironments[0]
    const response = (result: unknown) => ({
      id: args.method,
      ok: true as const,
      result,
      _meta: { runtimeId: environment.runtimeId! }
    })
    switch (args.method) {
      case 'status.get':
        return response(
          useAppStore.getState().runtimeStatusByEnvironmentId.get(environment.id)?.status
        )
      case 'repo.hooksCheck': {
        const pendingId = Object.keys(useAppStore.getState().pendingWorktreeCreations)[0]
        if (pendingId && !preparingCreationId) {
          preparingCreationId = pendingId
          await release.promise
        }
        return response(noHooks)
      }
      case 'preflight.detectAgents':
      case 'worktree.sparsePresets':
        return response([])
      case 'worktree.retiredNames':
        return response(EMPTY_RETIRED_NAME_REGISTRY)
      case 'github.repoSlug':
        return response(null)
      case 'settings.get':
        return response({ settings: useAppStore.getState().settings })
      case 'worktree.create':
        mutationHosts.push(environment.runtimeId!)
        return {
          id: args.method,
          ok: false,
          error: { code: 'fixture_create_refused', message: 'Test host refused creation.' }
        }
      default:
        throw new Error(`Unexpected runtime request: ${args.method}`)
    }
  }
  const subscribe: Window['api']['runtimeEnvironments']['subscribe'] = async (args, callbacks) => {
    callbacks.onResponse?.(await call(args))
    return { unsubscribe: () => {}, sendBinary: () => {} }
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: { repoSlug: async () => null },
      preflight: { detectAgents: async () => [] },
      worktrees: { listRetiredNames: async () => EMPTY_RETIRED_NAME_REGISTRY },
      sparsePresets: { list: async () => [] },
      hooks: { check: async () => noHooks },
      runtimeEnvironments: { call, subscribe, cancelSubscription: async () => {} }
    }
  })
  await act(async () =>
    openProjectComposer('repo-acme-web', 'remote-fix', true, {
      projectId: 'project-web',
      hostId: 'runtime:server-a',
      projectHostSetupId: 'setup-remote'
    })
  )
  render(<NewWorkspaceComposerModal />)
  try {
    await vi.waitFor(() =>
      expect(
        useAppStore.getState().pendingWorktreeCreations[preparingCreationId ?? '']
      ).toMatchObject({
        status: 'creating'
      })
    )
    act(() => {
      replaceProjectCreateRuntime()
      replaceRuntimeEnvironmentRevisions(useAppStore.getState().runtimeEnvironments)
      release.resolve()
    })
    await vi.waitFor(() =>
      expect(useAppStore.getState().pendingWorktreeCreations[preparingCreationId!]?.status).toBe(
        'error'
      )
    )
    expect(mutationHosts).toEqual([])

    act(() => retryBackgroundWorktreeCreation(preparingCreationId!))
    await vi.waitFor(() =>
      expect(useAppStore.getState().pendingWorktreeCreations[preparingCreationId!]?.status).toBe(
        'error'
      )
    )
    expect(mutationHosts).toEqual([])
  } finally {
    release.resolve()
  }
})

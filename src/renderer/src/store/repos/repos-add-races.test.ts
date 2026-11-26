import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { createTestStore } from '../testing/app-store-test-fixture'
import { runExclusiveForRuntimeEnvironment } from './pending-runtime-repo-removals'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/rpc/environment-revisions/runtime-environment-revision'
import { clearRuntimeCompatibilityCache } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const reposAdd: Mock = vi.fn()
const reposList: Mock = vi.fn()
const reposPickFolder: Mock = vi.fn()
const runtimeEnvironmentCall: Mock = vi.fn()
const runtimeEnvironmentTransportCall: Mock = vi.fn()
const runtimeEnvironmentsList: Mock = vi.fn()
const orcaProfileFindProjectProfiles: Mock = vi.fn()
const uiSet: Mock = vi.fn()

// Why: the add path routes through the environment transport, which answers protocol probes first.
beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([])
  clearRuntimeCompatibilityCache()
  reposAdd.mockReset()
  reposList.mockReset()
  reposPickFolder.mockReset()
  runtimeEnvironmentCall.mockReset()
  orcaProfileFindProjectProfiles.mockReset()
  uiSet.mockReset().mockResolvedValue(undefined)
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  runtimeEnvironmentsList.mockReset().mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList, add: reposAdd, pickFolder: reposPickFolder },
      orcaProfiles: { findProjectProfiles: orcaProfileFindProjectProfiles },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      },
      ui: { set: uiSet }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('repo add/catalog races', () => {
  it('does not add a selected folder to a replacement server while the add was queued', async () => {
    const remotePaths: string[] = []
    runtimeEnvironmentCall.mockImplementation(async (request) => {
      if (request.method === 'repo.add') {
        remotePaths.push(request.params.path)
      }
      return { ok: true, result: { repo: { ...localRepo, path: '/code/app' } } }
    })
    let release = () => {}
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = runExclusiveForRuntimeEnvironment('env-1', () => blocker)
    const store = createTestStore()
    let current = true
    const adding = store.getState().addRepoPath('/code/app', 'git', {
      runtimeEnvironmentId: 'env-1',
      targetGuard: {
        assertCurrent: () => {
          if (!current) {
            throw new Error('The selected server was replaced')
          }
        }
      }
    })
    current = false
    release()
    await queued

    expect(await adding).toBeNull()
    expect(remotePaths).toEqual([])
    expect(store.getState().repos).toEqual([])
  })

  it('appends the same bare ID when add returns a different host identity', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    const runtimeSibling: Repo = {
      ...localRepo,
      path: '/runtime/local-repo',
      executionHostId: 'runtime:env-1'
    }
    const store = createTestStore()
    store.setState({ repos: [runtimeSibling] })

    await store.getState().addRepoPath(localRepo.path)

    expect(store.getState().repos).toEqual([
      runtimeSibling,
      { ...localRepo, executionHostId: 'local' }
    ])
  })
})

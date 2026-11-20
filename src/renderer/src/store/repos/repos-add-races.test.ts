import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { createTestStore } from '../testing/app-store-test-fixture'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  reposAdd,
  runtimeEnvironmentCall
} from './repo-runtime-routing.test-fixture'
import { runExclusiveForRuntimeEnvironment } from './pending-runtime-repo-removals'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

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

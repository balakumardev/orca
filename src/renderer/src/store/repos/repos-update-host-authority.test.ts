import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { createTestStore } from '../testing/app-store-test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { runExclusiveForRuntimeEnvironment } from './pending-runtime-repo-removals'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const reposUpdate: Mock = vi.fn()
const runtimeEnvironmentCall: Mock = vi.fn()
const runtimeEnvironmentTransportCall: Mock = vi.fn()
const runtimeEnvironmentsList: Mock = vi.fn()

beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([])
  clearRuntimeCompatibilityCache()
  reposUpdate.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentsList.mockReset().mockResolvedValue([])
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: { update: reposUpdate },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      }
    }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('retires a late repo reply and the next serialized update when their selected host changes', async () => {
  const store = createTestStore()
  const owner: Repo = { ...remoteRepo, executionHostId: 'runtime:env-1' }
  store.setState({ repos: [owner] })
  const sent = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{ ok: true; result: { repo: Repo } }>()
  const remoteWrites: string[] = []
  runtimeEnvironmentCall.mockImplementation((request) => {
    const displayName = request.params.updates.displayName
    remoteWrites.push(displayName)
    if (displayName === 'First rename') {
      sent.resolve()
      return reply.promise
    }
    return Promise.resolve({ ok: true, result: { repo: { ...owner, displayName } } })
  })
  let current = true
  const targetGuard = {
    assertCurrent: () => {
      if (!current) {
        throw new Error('The selected server was replaced')
      }
    }
  }
  const first = store.getState().updateRepo(
    owner.id,
    { displayName: 'First rename' },
    {
      hostId: 'runtime:env-1',
      targetGuard
    }
  )
  await sent.promise
  const queued = store.getState().updateRepo(
    owner.id,
    { displayName: 'Queued rename' },
    {
      hostId: 'runtime:env-1',
      targetGuard
    }
  )
  // The response belongs to the old host even though the catalog now holds its replacement.
  current = false
  store.setState({ repos: [{ ...owner, displayName: 'Replacement server' }] })
  reply.resolve({ ok: true, result: { repo: { ...owner, displayName: 'First rename' } } })

  expect.soft(await Promise.all([first, queued])).toEqual([false, false])
  expect.soft(store.getState().repos[0]?.displayName).toBe('Replacement server')
  expect(remoteWrites).toEqual(['First rename'])
})

it('does not add a selected folder to a replacement server while the add was queued', async () => {
  const remotePaths: string[] = []
  runtimeEnvironmentCall.mockImplementation((request) => {
    if (request.method === 'repo.add') {
      remotePaths.push(request.params.path)
    }
    return Promise.resolve({ ok: true, result: { repo: { ...remoteRepo, path: '/code/app' } } })
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

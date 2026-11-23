import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { createTestStore } from '../testing/app-store-test-fixture'
import {
  installReposRuntimeRoutingHarness,
  remoteRepo,
  runtimeEnvironmentCall
} from './repo-runtime-routing.test-fixture'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
installReposRuntimeRoutingHarness()
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

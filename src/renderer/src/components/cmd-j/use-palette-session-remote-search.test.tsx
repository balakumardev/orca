// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { makeRepo } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import {
  paletteRuntimeEnvironment,
  paletteRuntimeStatus
} from './palette-runtime-host.test-fixture'
import { sessionHit } from './palette-session-hit.test-fixture'
import { usePaletteSessionSearch } from './use-palette-session-search'

const initialState = useAppStore.getInitialState()
const environment = paletteRuntimeEnvironment('intbox')
const ready: AiVaultSearchStatus = {
  enabled: true,
  phase: 'current',
  filesIndexed: 1,
  filesDue: 0,
  filesFailed: 0,
  degradedRoots: [],
  lastReconcileAt: 1,
  lastSweepCompletedAt: 1,
  generation: 1
}
const results = (...hits: AiVaultSearchHit[]): AiVaultSearchResponse => ({
  kind: 'results',
  hits,
  page: { cursor: null, hasMore: false },
  generation: 1,
  truncated: { candidates: false, snippets: 0, query: false, freshness: false },
  durationMs: 1
})

function installVault(
  search: (request: AiVaultSearchRequest, host?: string) => Promise<AiVaultSearchResponse>,
  status: (host?: string) => Promise<AiVaultSearchStatus> = async () => ready
) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchStatus: status, searchSessions: search } }
  })
}

async function searchSettles() {
  await act(async () => vi.advanceTimersByTimeAsync(200))
}

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(
    {
      ...initialState,
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([['intbox', paletteRuntimeStatus(environment)]]),
      settings: { ...initialState.settings!, aiVaultSearch: { enabled: true, historyDays: null } }
    },
    true
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(initialState, true)
})

describe('connected session search', () => {
  it('uses the remote consent even when local indexing is disabled', async () => {
    useAppStore.setState({
      settings: { ...initialState.settings!, aiVaultSearch: { enabled: false, historyDays: null } }
    })
    installVault(async (_request, host) =>
      results(sessionHit(host === 'runtime:intbox' ? 'remote' : 'local'))
    )
    const { result } = renderHook(() =>
      usePaletteSessionSearch({ query: 'billing', visible: true })
    )
    await searchSettles()
    expect(result.current.hits.map((hit) => [hit.executionHostId, hit.sessionId])).toEqual([
      ['runtime:intbox', 'remote']
    ])
  })

  it('publishes local results while a remote search is pending, then keeps both owners', async () => {
    const remote = Promise.withResolvers<AiVaultSearchResponse>()
    installVault(async (_request, host) =>
      host === 'runtime:intbox' ? remote.promise : results(sessionHit('same'))
    )
    const { result } = renderHook(() =>
      usePaletteSessionSearch({ query: 'billing', visible: true })
    )
    await searchSettles()
    expect(result.current.hits.map((hit) => [hit.executionHostId, hit.sessionId])).toEqual([
      ['local', 'same']
    ])
    await act(async () => remote.resolve(results(sessionHit('same'))))
    expect(result.current.hits.map((hit) => [hit.executionHostId, hit.sessionId])).toEqual([
      ['local', 'same'],
      ['runtime:intbox', 'same']
    ])
  })

  it('applies a host-only filter before searching', async () => {
    installVault(async (_request, host) =>
      results(sessionHit(host === 'runtime:intbox' ? 'remote' : 'local'))
    )
    const props = { query: 'billing', visible: true, hostIds: ['runtime:intbox'] }
    const { result } = renderHook(() => usePaletteSessionSearch(props))
    await searchSettles()
    expect(result.current.hits.map((hit) => hit.sessionId)).toEqual(['remote'])
  })

  it('resolves repository filters on their owner and fails closed for an unknown repository', async () => {
    useAppStore.setState({
      repos: [{ ...makeRepo(), id: 'remote-repo', executionHostId: 'runtime:intbox' }]
    })
    installVault(async (request, host) =>
      results(
        sessionHit(
          host === 'runtime:intbox' &&
            request.within?.kind === 'project' &&
            request.within.projectKey === 'repo:remote-repo'
            ? 'scoped'
            : 'too-broad'
        )
      )
    )
    const { result, rerender } = renderHook((props) => usePaletteSessionSearch(props), {
      initialProps: { query: 'billing', visible: true, repoIds: ['remote-repo'] }
    })
    await searchSettles()
    expect(result.current.hits.map((hit) => hit.sessionId)).toEqual(['scoped'])
    rerender({ query: 'billing', visible: true, repoIds: ['unknown-repo'] })
    await searchSettles()
    expect(result.current.hits).toEqual([])
  })

  it('discards a remote answer after its pairing is replaced', async () => {
    const old = Promise.withResolvers<AiVaultSearchResponse>()
    installVault(async (_request, host) => (host === 'runtime:intbox' ? old.promise : results()))
    const { result } = renderHook(() =>
      usePaletteSessionSearch({ query: 'billing', visible: true })
    )
    await searchSettles()
    await act(async () => {
      useAppStore.setState({ runtimeEnvironments: [{ ...environment, pairingRevision: 2 }] })
      old.resolve(results(sessionHit('retired-recording')))
    })
    expect(result.current.hits).toEqual([])
  })
})

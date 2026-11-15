// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store/index'
import type {
  AiVaultSearchHit,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { sessionHit } from './palette-session-hit.test-fixture'
import { usePaletteSessionSearch } from './use-palette-session-search'

vi.mock('@/app-shell/platform/web-client-location', () => ({ isWebClientLocation: vi.fn() }))

const initialAppState = useAppStore.getInitialState()

const READY: AiVaultSearchStatus = {
  enabled: true,
  phase: 'indexing',
  filesIndexed: 12,
  filesDue: 3,
  filesFailed: 0,
  degradedRoots: [],
  lastReconcileAt: 1794297600000,
  lastSweepCompletedAt: 1794297600000,
  generation: 1
}
const BUILDING: AiVaultSearchStatus = { ...READY, lastSweepCompletedAt: null }

function results(...hits: AiVaultSearchHit[]): AiVaultSearchResponse {
  return {
    kind: 'results',
    hits,
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  }
}

function installVault(vault: {
  searchStatus: (scope?: string) => Promise<AiVaultSearchStatus>
  searchSessions: (
    request: { query: string; limit: number },
    scope?: string
  ) => Promise<AiVaultSearchResponse>
}): void {
  Object.defineProperty(window, 'api', { configurable: true, value: { aiVault: vault } })
}

function setSearchEnabled(enabled: boolean): void {
  useAppStore.setState({
    settings: { ...initialAppState.settings!, aiVaultSearch: { enabled, historyDays: null } }
  })
}

const render = (initial: { query: string; visible: boolean }) =>
  renderHook((props) => usePaletteSessionSearch(props), { initialProps: initial })
const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(isWebClientLocation).mockReturnValue(false)
  useAppStore.setState(initialAppState, true)
  setSearchEnabled(true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(initialAppState, true)
})

describe('usePaletteSessionSearch', () => {
  it('asks the index for nothing while Agent Session History search is off', async () => {
    setSearchEnabled(false)
    const searchStatus = vi.fn(async () => READY)
    const searchSessions = vi.fn(async () => results(sessionHit('s-1')))
    installVault({ searchStatus, searchSessions })
    const { result } = render({ query: 'billing exporter', visible: true })
    await elapse(1000)
    expect(searchStatus).not.toHaveBeenCalled()
    expect(searchSessions).not.toHaveBeenCalled()
    expect(result.current).toEqual({ active: false, hits: [] })
  })

  it('asks for nothing while the palette is closed, on the web client, or for one character', async () => {
    const searchStatus = vi.fn(async () => READY)
    const searchSessions = vi.fn(async () => results(sessionHit('s-1')))
    installVault({ searchStatus, searchSessions })
    render({ query: 'billing', visible: false })
    render({ query: 'b', visible: true })
    vi.mocked(isWebClientLocation).mockReturnValue(true)
    render({ query: 'billing', visible: true })
    await elapse(1000)
    expect(searchStatus).not.toHaveBeenCalled()
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('searches this computer for the query typing settled on, for the best 6', async () => {
    const searchSessions = vi.fn(async () => results(sessionHit('s-1'), sessionHit('s-2')))
    installVault({ searchStatus: vi.fn(async () => READY), searchSessions })
    const { result, rerender } = render({ query: 'bi', visible: true })
    rerender({ query: 'bil', visible: true })
    await elapse(500)
    expect(searchSessions).toHaveBeenCalledExactlyOnceWith({ query: 'bil', limit: 6 }, 'local')
    expect(result.current.hits.map((hit) => hit.sessionId)).toEqual(['s-1', 's-2'])
  })

  it('shows nothing and searches nothing while the first index is still being built', async () => {
    const searchStatus = vi.fn(async () => BUILDING)
    const searchSessions = vi.fn(async () => results(sessionHit('s-1')))
    installVault({ searchStatus, searchSessions })
    const { result } = render({ query: 'billing', visible: true })
    await elapse(500)
    expect(searchSessions).not.toHaveBeenCalled()
    expect(result.current.hits).toEqual([])
  })

  it('waits out a 150 ms pause in typing before asking the index', async () => {
    const searchSessions = vi.fn(async () => results(sessionHit('s-1')))
    installVault({ searchStatus: vi.fn(async () => READY), searchSessions })
    render({ query: 'bil', visible: true })
    await elapse(149)
    expect(searchSessions).not.toHaveBeenCalled()
    await elapse(2)
    expect(searchSessions).toHaveBeenCalledTimes(1)
  })

  it('asks for the index status only until the index is ready', async () => {
    const searchStatus = vi.fn(async () => READY)
    installVault({ searchStatus, searchSessions: vi.fn(async () => results()) })
    const { rerender } = render({ query: 'billing', visible: true })
    await elapse(300)
    rerender({ query: 'billing exporter', visible: true })
    await elapse(300)
    rerender({ query: 'quarterly', visible: true })
    await elapse(300)
    expect(searchStatus).toHaveBeenCalledTimes(1)
  })

  it('asks for the status again on the next query while the first pass has not finished', async () => {
    const searchStatus = vi.fn<() => Promise<AiVaultSearchStatus>>(async () => BUILDING)
    const searchSessions = vi.fn(async () => results(sessionHit('s-1')))
    installVault({ searchStatus, searchSessions })
    const { result, rerender } = render({ query: 'billing', visible: true })
    await elapse(300)
    expect(searchSessions).not.toHaveBeenCalled()
    searchStatus.mockResolvedValue(READY)
    rerender({ query: 'billing exporter', visible: true })
    await elapse(300)
    expect(searchStatus).toHaveBeenCalledTimes(2)
    expect(result.current.hits.map((hit) => hit.sessionId)).toEqual(['s-1'])
  })

  it('checks the status again when the palette is opened again', async () => {
    const searchStatus = vi.fn(async () => READY)
    installVault({ searchStatus, searchSessions: vi.fn(async () => results()) })
    const { rerender } = render({ query: 'billing', visible: true })
    await elapse(300)
    rerender({ query: 'billing', visible: false })
    rerender({ query: 'billing', visible: true })
    await elapse(300)
    expect(searchStatus).toHaveBeenCalledTimes(2)
  })

  it('drops a slow answer to an earlier query', async () => {
    const pending = new Map<string, (response: AiVaultSearchResponse) => void>()
    const searchSessions = vi.fn(
      (request: { query: string }) =>
        new Promise<AiVaultSearchResponse>((resolve) => {
          pending.set(request.query, resolve)
        })
    )
    installVault({ searchStatus: vi.fn(async () => READY), searchSessions })
    const { result, rerender } = render({ query: 'bill', visible: true })
    await elapse(200)
    rerender({ query: 'billing', visible: true })
    await elapse(200)
    expect([...pending.keys()]).toEqual(['bill', 'billing'])
    await act(async () => {
      pending.get('billing')?.(results(sessionHit('s-new')))
    })
    await act(async () => {
      pending.get('bill')?.(results(sessionHit('s-old')))
    })
    expect(result.current.hits.map((hit) => hit.sessionId)).toEqual(['s-new'])
  })

  it('never shows the hits of an earlier query under a later one', async () => {
    installVault({
      searchStatus: vi.fn(async () => READY),
      searchSessions: vi.fn(async () => results(sessionHit('s-1')))
    })
    const { result, rerender } = render({ query: 'bill', visible: true })
    await elapse(200)
    expect(result.current.hits).toHaveLength(1)
    rerender({ query: 'billi', visible: true })
    expect(result.current.hits).toEqual([])
    rerender({ query: 'b', visible: true })
    expect(result.current.hits).toEqual([])
  })

  it('swallows a failed search and answers with no hits', async () => {
    installVault({
      searchStatus: vi.fn(async () => READY),
      searchSessions: vi.fn(async () => {
        throw new Error('index unavailable')
      })
    })
    const { result } = render({ query: 'billing', visible: true })
    await elapse(500)
    expect(result.current.hits).toEqual([])
  })

  it('treats an unavailable index as no hits', async () => {
    installVault({
      searchStatus: vi.fn(async () => READY),
      searchSessions: vi.fn(async () => ({ kind: 'unavailable', reason: 'not-ready' }) as const)
    })
    const { result } = render({ query: 'billing', visible: true })
    await elapse(500)
    expect(result.current.hits).toEqual([])
  })

  it('forgets its hits when the palette closes', async () => {
    installVault({
      searchStatus: vi.fn(async () => READY),
      searchSessions: vi.fn(async () => results(sessionHit('s-1')))
    })
    const { result, rerender } = render({ query: 'billing', visible: true })
    await elapse(200)
    expect(result.current.hits).toHaveLength(1)
    rerender({ query: 'billing', visible: false })
    expect(result.current.hits).toEqual([])
    rerender({ query: 'billing', visible: true })
    expect(result.current.hits).toEqual([])
  })
})

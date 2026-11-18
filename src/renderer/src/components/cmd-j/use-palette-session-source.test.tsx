// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store/index'
import type {
  AiVaultSearchHit,
  AiVaultSearchResponse
} from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { sessionHit } from './palette-session-hit.test-fixture'
import { readPaletteSessionFacts } from './palette-session-facts'
import { usePaletteSessionSource } from './use-palette-session-source'

vi.mock('@/app-shell/platform/web-client-location', () => ({ isWebClientLocation: vi.fn() }))
vi.mock('./use-palette-session-resume-catalogs', () => ({
  usePaletteSessionResumeCatalogs: vi.fn()
}))
vi.mock('./palette-session-facts', () => ({ readPaletteSessionFacts: vi.fn() }))

const initialAppState = useAppStore.getInitialState()

function installVault(hits: AiVaultSearchHit[]): void {
  const response: AiVaultSearchResponse = {
    kind: 'results',
    hits,
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        searchStatus: async () => ({
          enabled: true,
          phase: 'current',
          filesIndexed: 3,
          filesDue: 0,
          filesFailed: 0,
          degradedRoots: [],
          lastReconcileAt: 1794297600000,
          lastSweepCompletedAt: 1794297600000,
          generation: 1
        }),
        searchSessions: async () => response
      }
    }
  })
}

const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(isWebClientLocation).mockReturnValue(false)
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    settings: { ...initialAppState.settings!, aiVaultSearch: { enabled: true, historyDays: null } }
  })
  vi.mocked(readPaletteSessionFacts).mockImplementation((_state, hit) => ({
    nativeChat: false,
    originalPane: null,
    resumable: true,
    ownerWorkspaceId: hit.cwd === '/code/known' ? 'wt-known' : null,
    opensAsChat: true,
    terminalResumeWorkspaceId: 'wt-known',
    chatResume: { available: true, workspaceId: 'wt-known' }
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(initialAppState, true)
})

describe('usePaletteSessionSource', () => {
  it('is a Sessions section after the workspaces that never leads and has no empty-query rows', async () => {
    installVault([sessionHit('s-1', { cwd: '/code/known' })])
    const { result } = renderHook(() =>
      usePaletteSessionSource({ query: 'billing', visible: true })
    )
    await elapse(300)
    expect(result.current).toMatchObject({
      id: 'sessions',
      emptyQueryCap: 0,
      typedPlacement: 'after-workspaces',
      leadsOnTie: false
    })
    expect(result.current?.sectionLabel((_key, fallback) => fallback)).toBe('Sessions')
  })

  it('marks the row of an unknown folder inert and keeps the row of a known folder armed', async () => {
    installVault([
      sessionHit('s-unknown', { cwd: '/code/elsewhere' }),
      sessionHit('s-known', { cwd: '/code/known' })
    ])
    const { result } = renderHook(() =>
      usePaletteSessionSource({ query: 'billing', visible: true })
    )
    await elapse(300)
    expect(result.current?.results.map((row) => [row.title, row.inert])).toEqual([
      ['Title of s-unknown', true],
      ['Title of s-known', false]
    ])
  })

  it('is null for an empty query, and while Agent Session History search is off', async () => {
    installVault([sessionHit('s-1', { cwd: '/code/known' })])
    const empty = renderHook(() => usePaletteSessionSource({ query: '', visible: true }))
    await elapse(300)
    expect(empty.result.current).toBeNull()
    useAppStore.setState({
      settings: {
        ...initialAppState.settings!,
        aiVaultSearch: { enabled: false, historyDays: null }
      }
    })
    const off = renderHook(() => usePaletteSessionSource({ query: 'billing', visible: true }))
    await elapse(300)
    expect(off.result.current).toBeNull()
  })
})

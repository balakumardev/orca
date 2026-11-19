// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreePaletteRequestGuard } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { useAppStore } from '@/store/index'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import type {
  AiVaultSearchHit,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { sessionHit } from '../cmd-j/palette-session-hit.test-fixture'
import { useWorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { makeRecentTabState, makeRepo } from './worktree-jump-palette-test-fixtures'

vi.mock('@/components/settings/navigation/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const initialAppState = useAppStore.getInitialState()

const READY: AiVaultSearchStatus = {
  enabled: true,
  phase: 'current',
  filesIndexed: 12,
  filesDue: 0,
  filesFailed: 0,
  degradedRoots: [],
  lastReconcileAt: 1794297600000,
  lastSweepCompletedAt: 1794297600000,
  generation: 1
}

type Bridges = { hits?: AiVaultSearchHit[]; folders?: FolderSearchEntry[] }

function installBridges({ hits = [], folders = [] }: Bridges) {
  const searchSessions = vi.fn(async (): Promise<AiVaultSearchResponse> => ({
    kind: 'results',
    hits,
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  }))
  const searchStatus = vi.fn(async () => READY)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: { searchSessions, searchStatus },
      folderSearch: {
        list: async () => ({ entries: folders, truncated: false }),
        resolve: async () => null
      }
    }
  })
  return { searchSessions, searchStatus }
}

function setSearchEnabled(enabled: boolean): void {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, aiVaultSearch: { enabled, historyDays: null } }
  })
}

function usePalette() {
  const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])
  return useWorktreeJumpPaletteController({ visible: true, lingering: true, createLookupGuard })
}

const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

/** What the palette lists and arms for Enter once the typed query and the debounced search have settled. */
async function typeToQuery(query: string, bridges: Bridges) {
  const calls = installBridges(bridges)
  const { result, unmount } = renderHook(usePalette)
  await act(async () => {})
  await act(async () => result.current.handleQueryChange(query))
  await settle(400)
  const snapshot = {
    entries: result.current.listEntries.map((entry) => ({
      id: entry.id,
      session:
        entry.id === '__header_extra_sessions__' ||
        (entry.type === 'extra' && entry.sourceId === 'sessions')
    })),
    armedId: result.current.commandSelectedItemId,
    calls
  }
  unmount()
  return snapshot
}

type Snapshot = Awaited<ReturnType<typeof typeToQuery>>

const withoutSessions = (snapshot: Snapshot): string[] =>
  snapshot.entries.filter((entry) => !entry.session).map((entry) => entry.id)

describe('Cmd+J Sessions section', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(
      {
        ...initialAppState,
        ...makeRecentTabState(),
        repos: [makeRepo()],
        activeWorktreeId: 'wt-alpha',
        activeModal: 'worktree-palette'
      },
      true
    )
    setSearchEnabled(true)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState(initialAppState, true)
  })

  it('lists transcript hits for a typed query, after the workspaces and the folders', async () => {
    const snapshot = await typeToQuery('alpha', {
      hits: [sessionHit('s-1'), sessionHit('s-2')],
      folders: [{ path: '/code/alpha-notes', kind: 'folder' }]
    })
    const ids = snapshot.entries.map((entry) => entry.id)
    const header = ids.indexOf('__header_extra_sessions__')
    expect(header).toBeGreaterThan(0)
    expect(snapshot.entries.slice(header + 1).filter((entry) => entry.session)).toHaveLength(2)
    expect(ids.indexOf('__header_extra_folders__')).toBeGreaterThan(0)
    expect(ids.indexOf('__header_extra_folders__')).toBeLessThan(header)
    const firstWorkspaceRow = ids.findIndex((id) => id.includes('wt-alpha'))
    expect(firstWorkspaceRow).toBeGreaterThan(-1)
    expect(firstWorkspaceRow).toBeLessThan(header)
  })

  it('keeps the rows, their order and the armed row that the query had without the section', async () => {
    const baseline = await typeToQuery('alpha', {})
    const withHits = await typeToQuery('alpha', { hits: [sessionHit('s-1')] })
    expect(withHits.entries.some((entry) => entry.session)).toBe(true)
    expect(withoutSessions(withHits)).toEqual(withoutSessions(baseline))
    expect(withHits.armedId).toBe(baseline.armedId)
    expect(withHits.armedId).not.toBe('')
  })

  it('does not arm Enter for a transcript that is the only match', async () => {
    const baseline = await typeToQuery('zzquartz', {})
    const withHits = await typeToQuery('zzquartz', { hits: [sessionHit('s-1')] })
    expect(baseline.armedId).toBe('')
    expect(withHits.entries.some((entry) => entry.session)).toBe(true)
    expect(withHits.armedId).toBe('')
  })

  it('shows nothing and asks nothing while Agent Session History search is off', async () => {
    setSearchEnabled(false)
    const snapshot = await typeToQuery('alpha', { hits: [sessionHit('s-1')] })
    expect(snapshot.entries.some((entry) => entry.session)).toBe(false)
    expect(snapshot.calls.searchStatus).not.toHaveBeenCalled()
    expect(snapshot.calls.searchSessions).not.toHaveBeenCalled()
  })

  it('shows nothing for an empty query or a single character', async () => {
    const empty = await typeToQuery('', { hits: [sessionHit('s-1')] })
    const single = await typeToQuery('a', { hits: [sessionHit('s-1')] })
    expect(empty.entries.some((entry) => entry.session)).toBe(false)
    expect(single.entries.some((entry) => entry.session)).toBe(false)
    expect(single.calls.searchSessions).not.toHaveBeenCalled()
  })
})

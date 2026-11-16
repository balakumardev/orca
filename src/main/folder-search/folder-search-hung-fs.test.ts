import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFs } from './folder-search-fake-fs.test-fixture'
import { createFolderSearchService, type FolderSearchStore } from './folder-search-service'
import { scanFolderRoots } from './folder-search-scan'
import { collectTrackedFolderKeys } from './folder-search-tracked-paths'
import { getDefaultSettings } from '../../shared/constants'

vi.mock(
  'node:fs/promises',
  async () => (await import('./folder-search-fake-fs.test-fixture')).fakeFsModule
)

beforeEach(() => {
  fakeFs.reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const root = (path: string) => ({ path, realPath: path })
// Longer than any budget the scan may set for itself.
const LONG_WAIT_MS = 120_000

describe('a scan that meets a hung file system', () => {
  it('returns what it has, marked truncated, while every read hangs', async () => {
    fakeFs.dirs.set('/code', ['a'])
    fakeFs.hung = 'all'
    let settled = false
    const result = scanFolderRoots({ roots: [root('/code')] }).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ folders: [], truncated: true })
  })

  it('keeps the folders of the other roots when one root hangs', async () => {
    fakeFs.dirs.set('/stuck', ['never'])
    fakeFs.dirs.set('/fine', ['listed'])
    fakeFs.hung = new Set(['/stuck'])
    const result = scanFolderRoots({ roots: [root('/stuck'), root('/fine')] })
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    const { folders, truncated } = await result
    expect(folders.map((folder) => folder.path)).toEqual(['/fine', '/fine/listed'])
    expect(truncated).toBe(true)
  })

  it('schedules no more reads in a root after one of its reads hung', async () => {
    fakeFs.dirs.set('/code', ['first', 'second'])
    fakeFs.dirs.set('/code/first', [])
    fakeFs.dirs.set('/code/second', [])
    fakeFs.hung = new Set(['/code/first'])
    const result = scanFolderRoots({ roots: [root('/code')] })
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    await result
    expect(fakeFs.pathsCalled('readdir')).not.toContain('/code/second')
  })
})

function fakeStore(repoPaths: string[]): FolderSearchStore {
  return {
    getRepos: () =>
      repoPaths.map((path) => ({
        id: path,
        path,
        displayName: path,
        badgeColor: '#000000',
        addedAt: 0,
        kind: 'git',
        connectionId: null
      })),
    getFolderWorkspaces: () => [],
    getAllWorktreeMetaForHost: () => ({}),
    getSettings: () => ({
      ...getDefaultSettings('/home/me'),
      folderSearchLocations: ['/work/code']
    })
  }
}

describe('a list call that meets a hung file system', () => {
  it('answers while the scan hangs, and scans again on the next call', async () => {
    fakeFs.dirs.set('/work/code', ['notes'])
    fakeFs.dirs.set('/work/code/app', [])
    fakeFs.gitDirs.add('/work/code/app')
    fakeFs.hung = new Set(['readdir:/work/code'])
    // A cache lifetime longer than the whole test, so only the timed-out scan decides what happens next.
    const service = createFolderSearchService({
      store: fakeStore(['/work/code/app']),
      homeDir: '/home/me',
      ttlMs: 1_000_000_000
    })

    const first = service.list()
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    expect(await first).toEqual({
      entries: [{ path: '/work/code', realPath: '/work/code', kind: 'folder' }],
      truncated: true
    })

    fakeFs.hung = new Set()
    const second = service.list()
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    const { entries, truncated } = await second
    expect(entries.map((entry) => entry.path)).toEqual(['/work/code', '/work/code/notes'])
    expect(truncated).toBe(false)
  })

  it('skips a search root whose path cannot be resolved in time', async () => {
    fakeFs.dirs.set('/work/code', ['notes'])
    fakeFs.hung = new Set(['/work/code'])
    const service = createFolderSearchService({
      store: fakeStore(['/work/code/app']),
      homeDir: '/home/me'
    })
    const list = service.list()
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    expect(await list).toEqual({ entries: [], truncated: true })
  })
})

describe('tracked paths on a hung file system', () => {
  it('falls back to the written path instead of waiting', async () => {
    fakeFs.hung = 'all'
    const keys = collectTrackedFolderKeys({
      repos: [{ path: '/code/app', kind: 'folder', connectionId: null, executionHostId: null }],
      folderWorkspaces: [],
      localWorktreeIds: [],
      roots: [root('/code')]
    })
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
    expect([...(await keys)]).toEqual(['/code/app'])
  })
})

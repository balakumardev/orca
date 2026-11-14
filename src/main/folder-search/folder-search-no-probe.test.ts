import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFs } from './folder-search-fake-fs.test-fixture'
import { deriveFolderSearchRoots } from './folder-search-roots'
import { collectTrackedFolderKeys, dropTrackedFolders } from './folder-search-tracked-paths'
import type { ScannedFolder } from './folder-search-scan'

vi.mock(
  'node:fs/promises',
  async () => (await import('./folder-search-fake-fs.test-fixture')).fakeFsModule
)

beforeEach(() => fakeFs.reset())

const WSL_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app'
const roots = [{ path: '/code', realPath: '/code' }]
const repo = (path: string) => ({
  path,
  kind: 'git' as const,
  connectionId: null,
  executionHostId: null
})

describe('folder search never touches a path it cannot collide with', () => {
  it('reads no tracked path outside the search roots, and none on WSL', async () => {
    fakeFs.dirs.set('/code', [])
    const keys = await collectTrackedFolderKeys({
      repos: [repo('/code/app'), repo('/elsewhere/repo'), repo(WSL_PATH)],
      folderWorkspaces: [
        { folderPath: '/other/workspace', connectionId: null, executionHostId: null }
      ],
      localWorktreeIds: ['repo-1::/other/worktree'],
      roots
    })
    expect(fakeFs.pathsCalled().every((path) => path.startsWith('/code/app'))).toBe(true)
    // Outside the roots the written path still hides a matching entry.
    expect(keys.has('/elsewhere/repo')).toBe(true)
    expect(keys.has('/other/workspace')).toBe(true)
  })

  it('reads the main checkout of a linked worktree only inside the search roots', async () => {
    const linked = (path: string, mainCheckoutPath: string): ScannedFolder => ({
      path,
      kind: 'linked-worktree',
      mainCheckoutPath
    })
    await dropTrackedFolders(
      [
        linked('/code/one', '/outside/main'),
        linked('/code/two', WSL_PATH),
        linked('/code/three', '/code/main')
      ],
      new Set(),
      { roots, managedDirs: [] }
    )
    expect(fakeFs.pathsCalled()).toEqual(['/code/main'])
  })

  it('reads no WSL project to find a search root', async () => {
    const result = await deriveFolderSearchRoots({
      repos: [{ path: WSL_PATH, connectionId: null, executionHostId: null, addedAt: 0 }],
      homeDir: '/home/me',
      managedWorkspaceDirs: []
    })
    expect(result.roots).toEqual([])
    expect(fakeFs.pathsCalled().filter((path) => path.startsWith('\\\\'))).toEqual([])
  })
})

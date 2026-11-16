import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveFolderSearchRoots } from './folder-search-roots'
import {
  createFolderSearchTestTree,
  makePlainFolder,
  type FolderSearchTestTree
} from './folder-search-tree.test-fixture'

let tree: FolderSearchTestTree

beforeEach(async () => {
  tree = await createFolderSearchTestTree()
})
afterEach(() => tree.cleanup())

async function rootsFor(
  locations: string[],
  extra: {
    homeDir?: string
    managedWorkspaceDirs?: string[]
    maxRoots?: number
  } = {}
): Promise<string[]> {
  const { roots } = await deriveFolderSearchRoots({
    locations,
    homeDir: extra.homeDir ?? join(tree.root, 'home'),
    managedWorkspaceDirs: extra.managedWorkspaceDirs ?? [],
    maxRoots: extra.maxRoots
  })
  return roots.map((root) => root.realPath.slice(tree.root.length))
}

describe('deriveFolderSearchRoots', () => {
  it('uses the selected locations rather than their parents', async () => {
    await makePlainFolder(join(tree.root, 'code', 'app'))
    await makePlainFolder(join(tree.root, 'work', 'api'))
    expect(
      await rootsFor([join(tree.root, 'code', 'app'), join(tree.root, 'work', 'api')])
    ).toEqual(['/code/app', '/work/api'])
  })

  it('deduplicates a repeated location without merging neighboring folders', async () => {
    await makePlainFolder(join(tree.root, 'code', 'one'))
    await makePlainFolder(join(tree.root, 'code', 'two'))
    expect(
      await rootsFor([
        join(tree.root, 'code', 'one'),
        join(tree.root, 'code', 'one'),
        join(tree.root, 'code', 'two')
      ])
    ).toEqual(['/code/one', '/code/two'])
  })

  it('skips relative paths, SSH URLs and WSL locations', async () => {
    expect(
      await rootsFor([
        'relative/folder',
        'ssh://host/code',
        '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
      ])
    ).toEqual([])
  })

  it('expands Home and home-relative locations', async () => {
    await makePlainFolder(join(tree.root, 'home', 'direct-child'))
    expect(await rootsFor(['~', '~/direct-child'], { homeDir: join(tree.root, 'home') })).toEqual([
      '/home',
      '/home/direct-child'
    ])
  })

  it('skips Orca-managed workspace directories and anything inside them', async () => {
    await makePlainFolder(join(tree.root, 'orca-workspaces', 'repo-a', 'branch'))
    await makePlainFolder(join(tree.root, 'orca-workspaces', 'flat'))
    expect(
      await rootsFor(
        [
          join(tree.root, 'orca-workspaces'),
          join(tree.root, 'orca-workspaces', 'repo-a'),
          join(tree.root, 'orca-workspaces', 'flat')
        ],
        { managedWorkspaceDirs: [join(tree.root, 'orca-workspaces')] }
      )
    ).toEqual([])
  })

  it('keeps overlapping locations so each has its own depth budget', async () => {
    await makePlainFolder(join(tree.root, 'code', 'group', 'app'))
    await makePlainFolder(join(tree.root, 'code', 'other'))
    expect(await rootsFor([join(tree.root, 'code', 'group'), join(tree.root, 'code')])).toEqual([
      '/code',
      '/code/group'
    ])
  })

  it('keeps the first configured locations when there are more than the limit', async () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      await makePlainFolder(join(tree.root, name, 'app'))
    }
    expect(
      await rootsFor(
        ['a', 'b', 'c', 'd'].map((name) => join(tree.root, name)),
        { maxRoots: 2 }
      )
    ).toEqual(['/a', '/b'])
  })

  it('resolves a symlinked location and keeps the configured spelling beside it', async () => {
    await makePlainFolder(join(tree.root, 'real', 'app'))
    await symlink(join(tree.root, 'real'), join(tree.root, 'alias'))
    const { roots } = await deriveFolderSearchRoots({
      locations: [join(tree.root, 'alias')],
      homeDir: join(tree.root, 'home'),
      managedWorkspaceDirs: []
    })
    expect(roots).toEqual([
      {
        path: join(tree.root, 'alias'),
        realPath: join(tree.root, 'real'),
        spellings: [join(tree.root, 'alias')]
      }
    ])
  })

  it('skips a location that no longer exists', async () => {
    expect(await rootsFor([join(tree.root, 'gone')])).toEqual([])
  })
})

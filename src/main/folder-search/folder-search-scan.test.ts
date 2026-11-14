import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFolderRoots } from './folder-search-scan'
import {
  createFolderSearchTestTree,
  makeGitRoot,
  makeLinkedWorktree,
  makePlainFolder,
  makeSubmoduleCheckout,
  type FolderSearchTestTree
} from './folder-search-tree.test-fixture'

let tree: FolderSearchTestTree

beforeEach(async () => {
  tree = await createFolderSearchTestTree()
})
afterEach(() => tree.cleanup())

function scan(limits?: Parameters<typeof scanFolderRoots>[0]['limits']) {
  return scanFolderRoots({ roots: [{ path: tree.root, realPath: tree.root }], limits })
}

function listed(result: Awaited<ReturnType<typeof scan>>): string[] {
  return result.folders.map((folder) => `${folder.kind}:${folder.path.slice(tree.root.length + 1)}`)
}

describe('scanFolderRoots', () => {
  it('lists every direct child, marking git roots, and not the files', async () => {
    await makeGitRoot(join(tree.root, 'app'))
    await makePlainFolder(join(tree.root, 'notes'))
    await makePlainFolder(join(tree.root, 'empty-dir'))
    expect(listed(await scan())).toEqual(['git-root:app', 'folder:empty-dir', 'folder:notes'])
  })

  it('tells a linked worktree from a submodule by the gitdir the .git file names', async () => {
    await makeGitRoot(join(tree.root, 'main'))
    await makeLinkedWorktree({
      path: join(tree.root, 'feature'),
      mainCheckout: join(tree.root, 'main'),
      name: 'feature'
    })
    await makeSubmoduleCheckout(join(tree.root, 'vendored'), join(tree.root, 'main'))
    const result = await scan()
    expect(listed(result)).toEqual([
      'linked-worktree:feature',
      'git-root:main',
      'git-root:vendored'
    ])
    expect(result.folders[0].mainCheckoutPath).toBe(join(tree.root, 'main'))
    expect(result.folders[2].mainCheckoutPath).toBeNull()
  })

  it('lists git roots down to depth 3 and plain folders only at depth 1', async () => {
    await makeGitRoot(join(tree.root, 'group', 'team', 'service'))
    await makeGitRoot(join(tree.root, 'group', 'team', 'service', 'inner', 'deep'))
    await makeGitRoot(join(tree.root, 'one', 'two', 'three', 'too-deep'))
    await makePlainFolder(join(tree.root, 'one', 'two', 'plain'))
    expect(listed(await scan())).toEqual([
      'folder:group',
      'folder:one',
      'git-root:group/team/service'
    ])
  })

  it('does not descend into a git root', async () => {
    await makeGitRoot(join(tree.root, 'outer'))
    await makeGitRoot(join(tree.root, 'outer', 'packages', 'inner'))
    expect(listed(await scan())).toEqual(['git-root:outer'])
  })

  it('skips hidden folders, node_modules and the nested-repo scan skip list', async () => {
    for (const name of ['.config', 'node_modules', 'dist', 'vendor', 'visible']) {
      await makePlainFolder(join(tree.root, name))
    }
    await makeGitRoot(join(tree.root, 'visible', 'node_modules', 'pkg'))
    await makeGitRoot(join(tree.root, 'visible', '.hidden', 'repo'))
    expect(listed(await scan())).toEqual(['folder:visible'])
  })

  it('never follows a symbolic link', async () => {
    const outside = await createFolderSearchTestTree()
    try {
      await makeGitRoot(join(outside.root, 'elsewhere'))
      await symlink(outside.root, join(tree.root, 'link-to-dir'))
      await makePlainFolder(join(tree.root, 'real'))
      await symlink(join(tree.root, 'real'), join(tree.root, 'link-to-real'))
      expect(listed(await scan())).toEqual(['folder:real'])
    } finally {
      await outside.cleanup()
    }
  })

  it('reads through the real path but reports the path the user registered', async () => {
    await makePlainFolder(join(tree.root, 'real-parent', 'child'))
    await symlink(join(tree.root, 'real-parent'), join(tree.root, 'alias'))
    const result = await scanFolderRoots({
      roots: [{ path: join(tree.root, 'alias'), realPath: join(tree.root, 'real-parent') }]
    })
    expect(result.folders).toEqual([
      {
        path: join(tree.root, 'alias', 'child'),
        realPath: join(tree.root, 'real-parent', 'child'),
        kind: 'folder',
        mainCheckoutPath: null
      }
    ])
  })

  it('stops at the entry cap and says it was truncated', async () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      await makePlainFolder(join(tree.root, name))
    }
    const result = await scan({ maxEntries: 3 })
    expect(listed(result)).toEqual(['folder:a', 'folder:b', 'folder:c'])
    expect(result.truncated).toBe(true)
  })

  it('is not truncated when the cap equals what exists', async () => {
    await makePlainFolder(join(tree.root, 'a'))
    await makePlainFolder(join(tree.root, 'b'))
    expect((await scan({ maxEntries: 2 })).truncated).toBe(false)
  })

  it('keeps the nearest folders of a root when the cap cuts a deep scan short', async () => {
    await makeGitRoot(join(tree.root, 'zeta', 'inner', 'deep-repo'))
    await makePlainFolder(join(tree.root, 'alpha'))
    const result = await scan({ maxEntries: 2 })
    expect(listed(result)).toEqual(['folder:alpha', 'folder:zeta'])
    expect(result.truncated).toBe(true)
  })

  it('reports the real path of every folder it lists', async () => {
    await makePlainFolder(join(tree.root, 'plain'))
    await makeGitRoot(join(tree.root, 'repo'))
    const result = await scan()
    expect(result.folders.map((folder) => folder.realPath)).toEqual([
      join(tree.root, 'plain'),
      join(tree.root, 'repo')
    ])
  })

  it('gives every search root a share of the cap instead of filling it from the first', async () => {
    const rootNames = ['one', 'two', 'three']
    for (const rootName of rootNames) {
      for (let index = 0; index < 30; index++) {
        await makePlainFolder(join(tree.root, rootName, `folder-${index}`))
      }
    }
    const result = await scanFolderRoots({
      roots: rootNames.map((name) => ({
        path: join(tree.root, name),
        realPath: join(tree.root, name)
      })),
      limits: { maxEntries: 30 }
    })
    expect(result.truncated).toBe(true)
    expect(result.folders).toHaveLength(30)
    for (const rootName of rootNames) {
      const share = result.folders.filter((folder) =>
        folder.path.startsWith(join(tree.root, rootName))
      )
      // An even split is 10 each; the walk hands out batches of a few folders.
      expect(share.length).toBeGreaterThanOrEqual(8)
    }
  })

  it('lists a folder once when two nested search roots both reach it', async () => {
    await makeGitRoot(join(tree.root, 'code', 'team', 'service'))
    await makePlainFolder(join(tree.root, 'code', 'team', 'notes'))
    const result = await scanFolderRoots({
      roots: [
        { path: join(tree.root, 'code'), realPath: join(tree.root, 'code') },
        { path: join(tree.root, 'code', 'team'), realPath: join(tree.root, 'code', 'team') }
      ]
    })
    const paths = result.folders.map((folder) => folder.path.slice(tree.root.length + 1)).sort()
    expect(paths).toEqual(['code/team', 'code/team/notes', 'code/team/service'])
  })

  it('ignores a search root that cannot be read', async () => {
    await mkdir(join(tree.root, 'real'))
    const result = await scanFolderRoots({
      roots: [
        { path: join(tree.root, 'missing'), realPath: join(tree.root, 'missing') },
        { path: tree.root, realPath: tree.root }
      ]
    })
    expect(listed(result)).toEqual(['folder:real'])
  })
})

import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveFolderSearchRoots } from './folder-search-roots'
import { scanFolderRoots } from './folder-search-scan'
import { collectTrackedFolderKeys, dropTrackedFolders } from './folder-search-tracked-paths'
import {
  createFolderSearchTestTree,
  makeGitRoot,
  makePlainFolder,
  type FolderSearchTestTree
} from './folder-search-tree.test-fixture'

let tree: FolderSearchTestTree

beforeEach(async () => {
  tree = await createFolderSearchTestTree()
  await makeGitRoot(join(tree.root, 'code', 'proj'))
  await makeGitRoot(join(tree.root, 'code', 'other'))
  await makePlainFolder(join(tree.root, 'code', 'plain'))
  await symlink(join(tree.root, 'code'), join(tree.root, 'alias'))
})
afterEach(() => tree.cleanup())

const repo = (path: string, addedAt: number) => ({
  path,
  kind: 'git' as const,
  connectionId: null,
  executionHostId: null,
  addedAt
})

/** The whole pipeline a list call runs, with the projects registered the given way. */
async function listedNames(repos: ReturnType<typeof repo>[]): Promise<string[]> {
  const { roots } = await deriveFolderSearchRoots({
    repos,
    homeDir: join(tree.root, 'no-home'),
    tmpDir: join(tree.root, 'no-tmp'),
    managedWorkspaceDirs: []
  })
  const { folders } = await scanFolderRoots({ roots })
  const tracked = await collectTrackedFolderKeys({
    repos,
    folderWorkspaces: [],
    localWorktreeIds: [],
    roots
  })
  const visible = await dropTrackedFolders(folders, tracked, { roots, managedDirs: [] })
  // Spelled by real path, because the listed path follows whichever spelling the root kept.
  return visible.map((folder) => (folder.realPath ?? folder.path).slice(tree.root.length + 1))
}

describe('two projects in one folder, registered through different spellings of it', () => {
  const viaAlias = (): string => join(tree.root, 'alias', 'proj')
  const viaReal = (): string => join(tree.root, 'code', 'other')

  it.each([
    ['the alias project first', () => [repo(viaAlias(), 1), repo(viaReal(), 2)]],
    ['the real project first', () => [repo(viaReal(), 1), repo(viaAlias(), 2)]],
    ['the alias project newer', () => [repo(viaAlias(), 2), repo(viaReal(), 1)]],
    ['the real project newer', () => [repo(viaReal(), 2), repo(viaAlias(), 1)]]
  ])('lists neither project, with %s', async (_label, makeRepos) => {
    expect(await listedNames(makeRepos())).toEqual(['code/plain'])
  })

  it('keeps every spelling a root was reached through', async () => {
    const { roots } = await deriveFolderSearchRoots({
      repos: [repo(viaAlias(), 1), repo(viaReal(), 2)],
      homeDir: join(tree.root, 'no-home'),
      tmpDir: join(tree.root, 'no-tmp'),
      managedWorkspaceDirs: []
    })
    expect(roots).toHaveLength(1)
    // The first project's spelling, whichever call returned first.
    expect(roots[0].path).toBe(join(tree.root, 'alias'))
    expect([...(roots[0].spellings ?? [])].sort()).toEqual(
      [join(tree.root, 'alias'), join(tree.root, 'code')].sort()
    )
  })

  it('lists a project registered through the alias only', async () => {
    expect(await listedNames([repo(viaAlias(), 1)])).toEqual(['code/other', 'code/plain'])
  })
})

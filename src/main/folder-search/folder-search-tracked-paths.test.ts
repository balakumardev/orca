import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FolderSearchRoot } from './folder-search-roots'
import { scanFolderRoots } from './folder-search-scan'
import { collectTrackedFolderKeys, dropTrackedFolders } from './folder-search-tracked-paths'
import {
  createFolderSearchTestTree,
  makeGitRoot,
  makeLinkedWorktree,
  makePlainFolder,
  type FolderSearchTestTree
} from './folder-search-tree.test-fixture'

let tree: FolderSearchTestTree

beforeEach(async () => {
  tree = await createFolderSearchTestTree()
})
afterEach(() => tree.cleanup())

const repoAt = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  kind: 'git' as const,
  connectionId: null,
  executionHostId: null,
  ...extra
})

async function visibleAfterDedupe(args: {
  repos?: ReturnType<typeof repoAt>[]
  folderWorkspaces?: { folderPath: string; connectionId?: string | null }[]
  localWorktreeIds?: string[]
  scanPath?: FolderSearchRoot
  managedDirs?: string[]
}): Promise<string[]> {
  const roots = [args.scanPath ?? { path: tree.root, realPath: tree.root }]
  const { folders } = await scanFolderRoots({ roots })
  const tracked = await collectTrackedFolderKeys({
    repos: args.repos ?? [],
    folderWorkspaces: args.folderWorkspaces ?? [],
    localWorktreeIds: args.localWorktreeIds ?? [],
    roots
  })
  const visible = await dropTrackedFolders(folders, tracked, {
    roots,
    managedDirs: args.managedDirs ?? []
  })
  return visible.map((folder) => folder.path.slice(tree.root.length + 1))
}

describe('folder search dedupe', () => {
  it('drops a registered project, whichever kind it is', async () => {
    await makeGitRoot(join(tree.root, 'registered-git'))
    await makePlainFolder(join(tree.root, 'registered-folder'))
    await makePlainFolder(join(tree.root, 'unknown'))
    expect(
      await visibleAfterDedupe({
        repos: [
          repoAt(join(tree.root, 'registered-git')),
          repoAt(join(tree.root, 'registered-folder'), { kind: 'folder' })
        ]
      })
    ).toEqual(['unknown'])
  })

  it('compares real paths, so a project registered through a symlinked parent still matches', async () => {
    await makeGitRoot(join(tree.root, 'real', 'project'))
    await symlink(join(tree.root, 'real'), join(tree.root, 'alias'))
    expect(
      await visibleAfterDedupe({
        repos: [repoAt(join(tree.root, 'alias', 'project'))],
        scanPath: { path: join(tree.root, 'alias'), realPath: join(tree.root, 'real') }
      })
    ).toEqual([])
  })

  it.each([['real'], ['alias']])(
    'hides a project registered through another spelling of the same root, when the root kept the %s spelling',
    async (kept) => {
      await makeGitRoot(join(tree.root, 'real', 'project'))
      await makePlainFolder(join(tree.root, 'real', 'other'))
      await symlink(join(tree.root, 'real'), join(tree.root, 'alias'))
      expect(
        await visibleAfterDedupe({
          repos: [repoAt(join(tree.root, 'alias', 'project'))],
          scanPath: {
            path: join(tree.root, kept),
            realPath: join(tree.root, 'real'),
            spellings: [join(tree.root, 'alias'), join(tree.root, 'real')]
          }
        })
      ).toEqual([`${kept}/other`])
    }
  )

  it('drops the folder behind a tracked workspace', async () => {
    await makePlainFolder(join(tree.root, 'tracked-workspace'))
    await makePlainFolder(join(tree.root, 'tracked-worktree'))
    await makePlainFolder(join(tree.root, 'other'))
    expect(
      await visibleAfterDedupe({
        folderWorkspaces: [{ folderPath: join(tree.root, 'tracked-workspace') }],
        localWorktreeIds: [`repo-1::${join(tree.root, 'tracked-worktree')}`]
      })
    ).toEqual(['other'])
  })

  it('does not let a remote project hide a local folder at the same path', async () => {
    await makePlainFolder(join(tree.root, 'same-path'))
    expect(
      await visibleAfterDedupe({
        repos: [repoAt(join(tree.root, 'same-path'), { connectionId: 'conn-1' })],
        folderWorkspaces: [{ folderPath: join(tree.root, 'same-path'), connectionId: 'conn-1' }]
      })
    ).toEqual(['same-path'])
  })

  it('hides a linked worktree whose main checkout is registered', async () => {
    await makeGitRoot(join(tree.root, 'main'))
    await makeLinkedWorktree({
      path: join(tree.root, 'feature'),
      mainCheckout: join(tree.root, 'main'),
      name: 'feature'
    })
    expect(await visibleAfterDedupe({ repos: [repoAt(join(tree.root, 'main'))] })).toEqual([])
  })

  it('lists a linked worktree whose main checkout is not registered', async () => {
    await makeGitRoot(join(tree.root, 'main'))
    await makeLinkedWorktree({
      path: join(tree.root, 'feature'),
      mainCheckout: join(tree.root, 'main'),
      name: 'feature'
    })
    expect(await visibleAfterDedupe({ repos: [] })).toEqual(['feature', 'main'])
  })

  it('hides the main checkout of a project that was registered at a linked worktree', async () => {
    await makeGitRoot(join(tree.root, 'main'))
    await makeLinkedWorktree({
      path: join(tree.root, 'feature'),
      mainCheckout: join(tree.root, 'main'),
      name: 'feature'
    })
    expect(await visibleAfterDedupe({ repos: [repoAt(join(tree.root, 'feature'))] })).toEqual([])
  })

  it('drops a folder that is, or sits inside, a directory Orca creates workspaces in', async () => {
    await makePlainFolder(join(tree.root, 'orca-workspaces', 'repo-a'))
    await makePlainFolder(join(tree.root, 'repo-worktrees'))
    await makePlainFolder(join(tree.root, 'other'))
    expect(
      await visibleAfterDedupe({
        managedDirs: [join(tree.root, 'orca-workspaces'), join(tree.root, 'repo-worktrees')]
      })
    ).toEqual(['other'])
  })
})

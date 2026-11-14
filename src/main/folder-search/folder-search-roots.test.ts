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

const repoAt = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  connectionId: null,
  executionHostId: null,
  addedAt: 0,
  ...extra
})

async function rootsFor(
  repos: ReturnType<typeof repoAt>[],
  extra: {
    homeDir?: string
    tmpDir?: string
    managedWorkspaceDirs?: string[]
    maxRoots?: number
  } = {}
): Promise<string[]> {
  const { roots } = await deriveFolderSearchRoots({
    repos,
    homeDir: extra.homeDir ?? join(tree.root, 'home'),
    tmpDir: extra.tmpDir,
    managedWorkspaceDirs: extra.managedWorkspaceDirs ?? [],
    maxRoots: extra.maxRoots
  })
  return roots.map((root) => root.realPath.slice(tree.root.length))
}

describe('deriveFolderSearchRoots', () => {
  it('uses the parent directory of each local project, not the project itself', async () => {
    await makePlainFolder(join(tree.root, 'code', 'app'))
    await makePlainFolder(join(tree.root, 'work', 'api'))
    expect(
      await rootsFor([
        repoAt(join(tree.root, 'code', 'app')),
        repoAt(join(tree.root, 'work', 'api'))
      ])
    ).toEqual(['/code', '/work'])
  })

  it('counts folder projects as well as git projects, once per parent', async () => {
    await makePlainFolder(join(tree.root, 'code', 'one'))
    await makePlainFolder(join(tree.root, 'code', 'two'))
    expect(
      await rootsFor([
        repoAt(join(tree.root, 'code', 'one'), { kind: 'git' }),
        repoAt(join(tree.root, 'code', 'two'), { kind: 'folder' })
      ])
    ).toEqual(['/code'])
  })

  it('skips projects on SSH, runtime hosts and WSL', async () => {
    await makePlainFolder(join(tree.root, 'ssh', 'app'))
    await makePlainFolder(join(tree.root, 'runtime', 'app'))
    expect(
      await rootsFor([
        repoAt(join(tree.root, 'ssh', 'app'), { connectionId: 'conn-1' }),
        repoAt(join(tree.root, 'runtime', 'app'), { executionHostId: 'runtime:env-1' }),
        repoAt('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app')
      ])
    ).toEqual([])
  })

  it('skips the filesystem root and the home directory', async () => {
    await makePlainFolder(join(tree.root, 'home', 'direct-child'))
    expect(
      await rootsFor(
        [repoAt('/top-level-project'), repoAt(join(tree.root, 'home', 'direct-child'))],
        { homeDir: join(tree.root, 'home') }
      )
    ).toEqual([])
  })

  it('skips every folder that contains the home directory', async () => {
    const home = join(tree.root, 'users', 'me')
    await makePlainFolder(home)
    await makePlainFolder(join(home, 'code', 'app'))
    expect(
      await rootsFor([repoAt(home), repoAt(join(home, 'code', 'app'))], { homeDir: home })
    ).toEqual(['/users/me/code'])
  })

  it.skipIf(process.platform === 'win32')(
    'skips a top-level folder such as /usr, which holds the system and not projects',
    async () => {
      expect(await rootsFor([repoAt('/usr/bin')])).toEqual([])
    }
  )

  it('skips the folder the operating system keeps temporary files in', async () => {
    await makePlainFolder(join(tree.root, 'scratch', 'job'))
    await makePlainFolder(join(tree.root, 'code', 'app'))
    expect(
      await rootsFor(
        [repoAt(join(tree.root, 'scratch', 'job')), repoAt(join(tree.root, 'code', 'app'))],
        {
          tmpDir: join(tree.root, 'scratch')
        }
      )
    ).toEqual(['/code'])
  })

  it('skips Orca-managed workspace directories and anything inside them', async () => {
    await makePlainFolder(join(tree.root, 'orca-workspaces', 'repo-a', 'branch'))
    await makePlainFolder(join(tree.root, 'orca-workspaces', 'flat'))
    expect(
      await rootsFor(
        [
          repoAt(join(tree.root, 'orca-workspaces', 'repo-a', 'branch')),
          repoAt(join(tree.root, 'orca-workspaces', 'flat'))
        ],
        { managedWorkspaceDirs: [join(tree.root, 'orca-workspaces')] }
      )
    ).toEqual([])
  })

  it('keeps a root that sits inside another root, so its plain folders are still listed', async () => {
    await makePlainFolder(join(tree.root, 'code', 'group', 'app'))
    await makePlainFolder(join(tree.root, 'code', 'other'))
    expect(
      await rootsFor([
        repoAt(join(tree.root, 'code', 'group', 'app')),
        repoAt(join(tree.root, 'code', 'other'))
      ])
    ).toEqual(['/code', '/code/group'])
  })

  it('keeps the roots of the most recently added projects when there are more than the limit', async () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      await makePlainFolder(join(tree.root, name, 'app'))
    }
    expect(
      await rootsFor(
        ['a', 'b', 'c', 'd'].map((name, index) =>
          repoAt(join(tree.root, name, 'app'), { addedAt: index + 1 })
        ),
        { maxRoots: 2 }
      )
    ).toEqual(['/c', '/d'])
  })

  it('resolves a symlinked parent and keeps the registered spelling beside it', async () => {
    await makePlainFolder(join(tree.root, 'real', 'app'))
    await symlink(join(tree.root, 'real'), join(tree.root, 'alias'))
    const { roots } = await deriveFolderSearchRoots({
      repos: [repoAt(join(tree.root, 'alias', 'app'))],
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

  it('skips a parent that no longer exists', async () => {
    expect(await rootsFor([repoAt(join(tree.root, 'gone', 'app'))])).toEqual([])
  })
})

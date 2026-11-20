import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveFolderSearchRoots } from './folder-search-roots'
import { createFolderSearchService } from './folder-search-service'
import { getDefaultSettings } from '../../shared/orca-profiles/constants'
import type { Repo } from '../../shared/repository/repo-types'
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
  id: path,
  displayName: path,
  badgeColor: '',
  path,
  kind: 'git' as const,
  connectionId: null,
  executionHostId: null,
  addedAt
})

function serviceFor(
  repos: Repo[],
  locations = [join(tree.root, 'alias'), join(tree.root, 'code')]
) {
  const homeDir = join(tree.root, 'no-home')
  return createFolderSearchService({
    homeDir,
    store: {
      getRepos: () => repos,
      getFolderWorkspaces: () => [],
      getAllWorktreeMetaForHost: () => ({}),
      getSettings: () => ({
        ...getDefaultSettings(homeDir),
        folderSearchLocations: locations
      })
    }
  })
}

/** Exercise the real list entry point with two configured spellings of the same location. */
async function listedNames(repos: ReturnType<typeof repo>[]): Promise<string[]> {
  const service = serviceFor(repos)
  return (await service.list()).entries.map((folder) =>
    (folder.realPath ?? folder.path).slice(tree.root.length + 1)
  )
}

describe('two projects in one folder, registered through different spellings of it', () => {
  const viaAlias = (): string => join(tree.root, 'alias', 'proj')
  const viaReal = (): string => join(tree.root, 'code', 'other')

  it.each([
    ['the alias project first', () => [repo(viaAlias(), 1), repo(viaReal(), 2)]],
    ['the real project first', () => [repo(viaReal(), 1), repo(viaAlias(), 2)]]
  ])('lists neither project, with %s', async (_label, makeRepos) => {
    expect(await listedNames(makeRepos())).toEqual(['code', 'code/plain'])
  })

  it('keeps every spelling a root was reached through', async () => {
    const { roots } = await deriveFolderSearchRoots({
      locations: [join(tree.root, 'alias'), join(tree.root, 'code')],
      homeDir: join(tree.root, 'no-home'),
      managedWorkspaceDirs: []
    })
    expect(roots).toHaveLength(1)
    // The first configured spelling, regardless of filesystem completion order.
    expect(roots[0].path).toBe(join(tree.root, 'alias'))
    expect([...(roots[0].spellings ?? [])].sort()).toEqual(
      [join(tree.root, 'alias'), join(tree.root, 'code')].sort()
    )
  })

  it('lists a project registered through the alias only', async () => {
    expect(await listedNames([repo(viaAlias(), 1)])).toEqual(['code', 'code/other', 'code/plain'])
  })

  it.each(['parent', 'project'] as const)(
    'hides a registered %s alias with only the real location configured, even after a cached scan',
    async (aliasKind) => {
      const repos: Repo[] = []
      const service = serviceFor(repos, [join(tree.root, 'code')])
      const target = join(tree.root, 'code', 'plain')
      const projectAlias = join(tree.root, 'links', 'plain')
      await makePlainFolder(join(tree.root, 'links'))
      await symlink(target, projectAlias)
      expect((await service.list()).entries.map((entry) => entry.path)).toContain(target)

      const registered = aliasKind === 'parent' ? join(tree.root, 'alias', 'plain') : projectAlias
      repos.push({ ...repo(registered, 1), kind: 'folder' })
      expect(await service.resolve(target)).toBeNull()
      expect(
        (await service.list()).entries.map((entry) => entry.path.slice(tree.root.length + 1))
      ).toEqual(['code', 'code/other', 'code/proj'])
    }
  )
})

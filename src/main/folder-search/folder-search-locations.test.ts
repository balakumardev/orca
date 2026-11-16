import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { createFolderSearchService, type FolderSearchStore } from './folder-search-service'
import {
  createFolderSearchTestTree,
  makeGitRoot,
  makePlainFolder,
  type FolderSearchTestTree
} from './folder-search-tree.test-fixture'

let tree: FolderSearchTestTree
beforeEach(async () => {
  tree = await createFolderSearchTestTree()
})
afterEach(() => tree.cleanup())

function setup(locations?: string[], trackHome = false) {
  const home = join(tree.root, 'home')
  const settings = { ...getDefaultSettings(home), folderSearchLocations: locations }
  const store: FolderSearchStore = {
    getRepos: () =>
      trackHome
        ? [
            {
              id: 'home',
              path: home,
              displayName: 'Home',
              badgeColor: '',
              addedAt: 0,
              kind: 'folder'
            }
          ]
        : [],
    getFolderWorkspaces: () => [],
    getAllWorktreeMetaForHost: () => ({}),
    getSettings: () => settings
  }
  const service = createFolderSearchService({ store, homeDir: home })
  const listed = async () =>
    (await service.list()).entries.map((entry) => `${entry.kind}:${entry.path.slice(home.length)}`)
  return { home, settings, service, listed }
}

describe('folder search locations', () => {
  it.each([
    [false, ['folder:', 'folder:/workspace', 'folder:/workspace/ramp-workspace']],
    [true, ['folder:/workspace', 'folder:/workspace/ramp-workspace']]
  ] as const)(
    'discovers nested plain folders with only Home tracked: %s',
    async (trackHome, want) => {
      const { home, listed } = setup(undefined, trackHome)
      await makePlainFolder(join(home, 'workspace', 'ramp-workspace'))
      expect(await listed()).toEqual(want)
    }
  )

  it('uses saved roots, includes the roots, and traverses plain and Git folders through depth 3', async () => {
    const { home, listed } = setup(['~/workspace', '~/personal'])
    await makePlainFolder(join(home, 'workspace', 'ramp-workspace', 'notes', 'drafts', 'too-deep'))
    await makeGitRoot(join(home, 'personal', 'orca'))
    await makePlainFolder(join(home, 'personal', 'orca', 'src', 'main'))
    await makePlainFolder(join(home, 'elsewhere', 'unselected'))
    expect((await listed()).sort()).toEqual([
      'folder:/personal',
      'folder:/personal/orca/src',
      'folder:/personal/orca/src/main',
      'folder:/workspace',
      'folder:/workspace/ramp-workspace',
      'folder:/workspace/ramp-workspace/notes',
      'folder:/workspace/ramp-workspace/notes/drafts',
      'git-root:/personal/orca'
    ])
  })

  it('changes coverage immediately when locations are edited or cleared', async () => {
    const { home, settings, listed } = setup(['~/personal'])
    await makePlainFolder(join(home, 'personal', 'notes'))
    await makePlainFolder(join(home, 'workspace', 'ramp-workspace'))
    expect(await listed()).toEqual(['folder:/personal', 'folder:/personal/notes'])
    settings.folderSearchLocations = ['~/workspace']
    expect(await listed()).toEqual(['folder:/workspace', 'folder:/workspace/ramp-workspace'])
    settings.folderSearchLocations = []
    expect(await listed()).toEqual([])
  })
})

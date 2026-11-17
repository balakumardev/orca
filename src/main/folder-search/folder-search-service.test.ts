import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFolderSearchService } from './folder-search-service'
import type { FolderSearchStore } from './folder-search-service'
import { scanFolderRoots } from './folder-search-scan'
import { getDefaultSettings } from '../../shared/constants'
import type { Repo } from '../../shared/repo-types'
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

function fakeStore(repoPaths: string[], repoExtras: Partial<Repo> = {}) {
  const state = { repoPaths }
  const store: FolderSearchStore = {
    getRepos: () =>
      state.repoPaths.map((path) => ({
        id: path,
        path,
        displayName: path,
        badgeColor: '#000000',
        addedAt: 0,
        kind: 'git',
        connectionId: null,
        ...repoExtras
      })),
    getFolderWorkspaces: () => [],
    getAllWorktreeMetaForHost: () => ({}),
    getSettings: () => ({
      ...getDefaultSettings(join(tree.root, 'home')),
      folderSearchLocations: [join(tree.root, 'code')],
      workspaceDir: join(tree.root, 'orca-workspaces')
    })
  }
  return { state, store }
}

function setup(repoPaths: string[], repoExtras: Partial<Repo> = {}) {
  const { state, store } = fakeStore(repoPaths, repoExtras)
  const clock = { now: 1_000 }
  const scans = { count: 0 }
  const service = createFolderSearchService({
    store,
    homeDir: join(tree.root, 'home'),
    ttlMs: CACHE_TTL_MS,
    now: () => clock.now,
    scan: (args) => {
      scans.count += 1
      return scanFolderRoots(args)
    }
  })
  const names = async () =>
    (await service.list()).entries.map((entry) => entry.path.slice(tree.root.length + 1))
  return { state, clock, scans, service, names }
}

const CACHE_TTL_MS = 1000

describe('createFolderSearchService', () => {
  it('lists the configured root and its folders but not an already registered project', async () => {
    await makeGitRoot(join(tree.root, 'code', 'app'))
    await makePlainFolder(join(tree.root, 'code', 'notes'))
    const { names } = setup([join(tree.root, 'code', 'app')])
    expect(await names()).toEqual(['code', 'code/notes'])
  })

  it('reuses one scan until the time to live passes', async () => {
    await makeGitRoot(join(tree.root, 'code', 'app'))
    const { clock, names, scans } = setup([join(tree.root, 'code', 'app')])
    expect(await names()).toEqual(['code'])
    await makePlainFolder(join(tree.root, 'code', 'late'))
    clock.now += CACHE_TTL_MS - 1
    expect(await names()).toEqual(['code'])
    expect(scans.count).toBe(1)
    clock.now += 1
    expect(await names()).toEqual(['code', 'code/late'])
    expect(scans.count).toBe(2)
  })

  it('applies the registered-project filter on every call, with no rescan', async () => {
    await makeGitRoot(join(tree.root, 'code', 'app'))
    await makePlainFolder(join(tree.root, 'code', 'notes'))
    const { state, names, scans } = setup([join(tree.root, 'code', 'app')])
    expect(await names()).toEqual(['code', 'code/notes'])
    state.repoPaths.push(join(tree.root, 'code', 'notes'))
    expect(await names()).toEqual(['code'])
    state.repoPaths.pop()
    expect(await names()).toEqual(['code', 'code/notes'])
    expect(scans.count).toBe(1)
  })

  it('shares one scan between palette opens that overlap', async () => {
    await makeGitRoot(join(tree.root, 'code', 'app'))
    const { service, scans } = setup([join(tree.root, 'code', 'app')])
    await Promise.all([service.list(), service.list(), service.list()])
    expect(scans.count).toBe(1)
  })

  it('reports a truncated scan', async () => {
    await makeGitRoot(join(tree.root, 'code', 'app'))
    await makePlainFolder(join(tree.root, 'code', 'one'))
    await makePlainFolder(join(tree.root, 'code', 'two'))
    const { store } = fakeStore([join(tree.root, 'code', 'app')])
    const service = createFolderSearchService({
      store,
      homeDir: join(tree.root, 'home'),
      limits: { maxEntries: 2 }
    })
    expect((await service.list()).truncated).toBe(true)
  })

  it('does not list the folder a project keeps its worktrees in', async () => {
    await makeGitRoot(join(tree.root, 'code', 'app'))
    await makePlainFolder(join(tree.root, 'code', 'app-worktrees'))
    await makePlainFolder(join(tree.root, 'code', 'notes'))
    const { names } = setup([join(tree.root, 'code', 'app')], {
      worktreeBasePath: join(tree.root, 'code', 'app-worktrees')
    })
    expect(await names()).toEqual(['code', 'code/notes'])
  })

  describe('resolve', () => {
    const rootPath = () => join(tree.root, 'code')

    it('answers with the fresh entry for a folder from the last list', async () => {
      await makeGitRoot(join(rootPath(), 'app'))
      await makePlainFolder(join(rootPath(), 'notes'))
      const { service } = setup([join(rootPath(), 'app')])
      await service.list()
      expect(await service.resolve(join(rootPath(), 'notes'))).toEqual({
        path: join(rootPath(), 'notes'),
        kind: 'folder',
        realPath: join(rootPath(), 'notes')
      })
    })

    it('answers with the kind the folder has now', async () => {
      await makeGitRoot(join(rootPath(), 'app'))
      await makePlainFolder(join(rootPath(), 'notes'))
      const { service } = setup([join(rootPath(), 'app')])
      await service.list()
      await makeGitRoot(join(rootPath(), 'notes'))
      expect(await service.resolve(join(rootPath(), 'notes'))).toMatchObject({ kind: 'git-root' })
    })

    it('answers null for a folder that was deleted, and rescans on the next list', async () => {
      await makeGitRoot(join(rootPath(), 'app'))
      await makePlainFolder(join(rootPath(), 'notes'))
      const { service, names, scans } = setup([join(rootPath(), 'app')])
      expect(await names()).toEqual(['code', 'code/notes'])
      await rm(join(rootPath(), 'notes'), { recursive: true })
      expect(await service.resolve(join(rootPath(), 'notes'))).toBeNull()
      expect(await names()).toEqual(['code'])
      expect(scans.count).toBe(2)
    })

    it('answers null for a folder that has become a project since the list', async () => {
      await makeGitRoot(join(rootPath(), 'app'))
      await makePlainFolder(join(rootPath(), 'notes'))
      const { service, state } = setup([join(rootPath(), 'app')])
      await service.list()
      state.repoPaths.push(join(rootPath(), 'notes'))
      expect(await service.resolve(join(rootPath(), 'notes'))).toBeNull()
    })

    it('answers null for a path the last list did not offer, even if it exists', async () => {
      await makeGitRoot(join(rootPath(), 'app'))
      const { service } = setup([join(rootPath(), 'app')])
      await service.list()
      expect(await service.resolve(tree.root)).toBeNull()
    })

    it('answers null before anything was listed', async () => {
      await makePlainFolder(join(rootPath(), 'notes'))
      const { service } = setup([])
      expect(await service.resolve(join(rootPath(), 'notes'))).toBeNull()
    })
  })
})

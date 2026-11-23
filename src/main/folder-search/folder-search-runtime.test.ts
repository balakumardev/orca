import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/orca-profiles/constants'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods/rpc-method-registry'
import {
  createFolderSearchTestTree,
  makeGitRoot,
  makePlainFolder
} from './folder-search-tree.test-fixture'

it('discovers from the persisted host catalog and resolves only its still-untracked offers across RPC calls', async () => {
  const tree = await createFolderSearchTestTree()
  const code = join(tree.root, 'host-code')
  const notes = join(code, 'notes')
  const project = join(code, 'tracked')
  const clientOnly = join(tree.root, 'client-only')
  const managed = join(code, 'managed')
  const databasePath = join(tree.root, 'profile-state.db')
  const seed = new ProfileStateSqliteAuthority(databasePath, 'folder-search-host')
  const state = getDefaultPersistedState(tree.root)
  state.settings.folderSearchLocations = [code]
  state.settings.workspaceDir = managed
  state.repos = [
    {
      id: 'tracked-project',
      path: project,
      displayName: 'Tracked',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git'
    }
  ]
  await Promise.all([
    makeGitRoot(project),
    makeGitRoot(join(code, 'fresh')),
    makePlainFolder(notes),
    makePlainFolder(join(managed, 'child')),
    makePlainFolder(clientOnly)
  ])
  seed.writeSerializedState(Buffer.from(JSON.stringify(state)))
  seed.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'folder-search-host')
  const store = new Store({
    dataFile: join(tree.root, 'orca-data.json'),
    storageAuthority: 'runtime',
    profileStateAuthority: authority
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Folder RPC dispatch only needs these runtime methods; discovery uses the real reopened store.
  const runtime = {
    getRuntimeId: () => 'folder-search-host',
    requireStore: () => store
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: ALL_RPC_METHODS,
    callerScope: { kind: 'runtime-paired', grants: [] }
  })
  const call = (method: string, params?: unknown) =>
    dispatcher.dispatch({ id: 'folder-search', authToken: 'test', method, params })
  try {
    expect(await call('folderSearch.list', { folderSearchLocations: [clientOnly] })).toMatchObject({
      ok: true,
      result: {
        entries: [
          { path: code, realPath: code, kind: 'folder' },
          { path: join(code, 'fresh'), realPath: join(code, 'fresh'), kind: 'git-root' },
          { path: notes, realPath: notes, kind: 'folder' }
        ],
        truncated: false
      }
    })
    expect(await call('folderSearch.resolve', { path: notes })).toMatchObject({
      ok: true,
      result: { path: notes, realPath: notes, kind: 'folder' }
    })
    expect(await call('folderSearch.resolve', { path: clientOnly })).toMatchObject({
      ok: true,
      result: null
    })
    store.addRepo({
      id: 'new-folder-project',
      path: notes,
      displayName: 'Notes',
      badgeColor: 'blue',
      addedAt: 2,
      kind: 'folder'
    })
    expect(await call('folderSearch.resolve', { path: notes })).toMatchObject({
      ok: true,
      result: null
    })
  } finally {
    store.freezeWrites()
    await store.flushAsync()
    authority.close()
    await tree.cleanup()
  }
})

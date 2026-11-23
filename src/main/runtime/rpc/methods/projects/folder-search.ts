import { FolderSearchResolveParams } from '../../../../../shared/folder-search-types'
import { createFolderSearchService } from '../../../../folder-search/folder-search-service'
import type { RuntimeStore } from '../../../construction/runtime-store-contract'
import { defineMethod } from '../../core'

// RPC requests may arrive on separate sockets; the host store owns the last offered paths.
const services = new WeakMap<RuntimeStore, ReturnType<typeof createFolderSearchService>>()

function serviceFor(store: RuntimeStore) {
  let service = services.get(store)
  if (!service) {
    const { getFolderWorkspaces, getAllWorktreeMetaForHost } = store
    if (!getFolderWorkspaces || !getAllWorktreeMetaForHost) {
      throw new Error('runtime_unavailable')
    }
    service = createFolderSearchService({
      store: {
        getRepos: () => store.getRepos(),
        getSettings: () => store.getSettings(),
        getFolderWorkspaces: () => getFolderWorkspaces.call(store),
        getAllWorktreeMetaForHost: (hostId) => getAllWorktreeMetaForHost.call(store, hostId)
      }
    })
    services.set(store, service)
  }
  return service
}

export const FOLDER_SEARCH_METHODS = [
  defineMethod({
    name: 'folderSearch.list',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => serviceFor(runtime.requireStore()).list()
  }),
  defineMethod({
    name: 'folderSearch.resolve',
    permission: 'workspace',
    params: FolderSearchResolveParams,
    handler: (params, { runtime }) => serviceFor(runtime.requireStore()).resolve(params.path)
  })
]

import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { createFolderSearchService } from '../../folder-search/folder-search-service'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId
} from '../../../shared/execution-host'
import type { FolderSearchEntry, FolderSearchResult } from '../../../shared/folder-search-types'
import { getRuntimeEnvironmentRegistryRoot } from '../runtime-environments/runtime-environment-registry-root'
import {
  listRuntimeFolders,
  resolveRuntimeFolder
} from '../../folder-search/runtime-folder-search-client'

function addressedHost(value: unknown) {
  const host =
    value === undefined
      ? parseRoutableExecutionHostId(LOCAL_EXECUTION_HOST_ID)
      : typeof value === 'string'
        ? parseRoutableExecutionHostId(value)
        : null
  if (!host) {
    throw new Error('invalid_folder_search_host')
  }
  return host
}

/** Each host owns its roots and offered paths; an unavailable remote never falls back to local. */
export function registerFolderSearchHandlers(store: Store): void {
  const service = createFolderSearchService({ store })
  ipcMain.handle(
    'folderSearch:list',
    async (_event, executionHostId: unknown): Promise<FolderSearchResult> => {
      const host = addressedHost(executionHostId)
      const result =
        host.kind === 'local'
          ? await service.list()
          : await listRuntimeFolders(getRuntimeEnvironmentRegistryRoot(), host)
      return {
        ...result,
        entries: result.entries.map((entry) => ({ ...entry, executionHostId: host.id }))
      }
    }
  )
  // The path is only a key into what main listed last; main never reads a path the renderer made up.
  ipcMain.handle(
    'folderSearch:resolve',
    async (_event, path: unknown, executionHostId: unknown): Promise<FolderSearchEntry | null> => {
      const host = addressedHost(executionHostId)
      if (typeof path !== 'string') {
        return null
      }
      const entry =
        host.kind === 'local'
          ? await service.resolve(path)
          : await resolveRuntimeFolder(getRuntimeEnvironmentRegistryRoot(), host, path)
      return entry ? { ...entry, executionHostId: host.id } : null
    }
  )
}

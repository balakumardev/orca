import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { createFolderSearchService } from '../../folder-search/folder-search-service'

/** Local desktop only: the search roots come from this machine's registered projects, never from the renderer. */
export function registerFolderSearchHandlers(store: Store): void {
  const service = createFolderSearchService({ store })
  ipcMain.handle('folderSearch:list', () => service.list())
  // The path is only a key into what main listed last; main never reads a path the renderer made up.
  ipcMain.handle('folderSearch:resolve', (_event, path: unknown) =>
    typeof path === 'string' ? service.resolve(path) : null
  )
}

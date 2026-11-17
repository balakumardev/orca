import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { createFolderSearchService } from '../../folder-search/folder-search-service'

/** Local desktop only: search roots come from this machine's saved settings, not list-call arguments. */
export function registerFolderSearchHandlers(store: Store): void {
  const service = createFolderSearchService({ store })
  ipcMain.handle('folderSearch:list', () => service.list())
  // The path is only a key into what main listed last; main never reads a path the renderer made up.
  ipcMain.handle('folderSearch:resolve', (_event, path: unknown) =>
    typeof path === 'string' ? service.resolve(path) : null
  )
}

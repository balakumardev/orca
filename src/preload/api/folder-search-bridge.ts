import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const folderSearchApi = {
  // Main routes both calls to the same addressed host's discovery service.
  list: (executionHostId) => ipcRenderer.invoke('folderSearch:list', executionHostId),
  resolve: (path, executionHostId) =>
    ipcRenderer.invoke('folderSearch:resolve', path, executionHostId)
} satisfies PreloadApi['folderSearch']

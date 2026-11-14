import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const folderSearchApi = {
  list: () => ipcRenderer.invoke('folderSearch:list'),
  resolve: (path) => ipcRenderer.invoke('folderSearch:resolve', path)
} satisfies PreloadApi['folderSearch']

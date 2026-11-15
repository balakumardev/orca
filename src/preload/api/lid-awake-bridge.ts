import { ipcRenderer } from 'electron'
import type { LidAwakeState } from '../../shared/lid-closed-awake'
import type { PreloadApi } from '../api-types'

export const lidAwakeApi = {
  getState: () => ipcRenderer.invoke('lidAwake:getState'),
  onChanged: (callback: (state: LidAwakeState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: LidAwakeState): void =>
      callback(state)
    ipcRenderer.on('lidAwake:changed', listener)
    return () => ipcRenderer.removeListener('lidAwake:changed', listener)
  },
  setConfig: (patch) => ipcRenderer.invoke('lidAwake:setConfig', patch),
  setup: () => ipcRenderer.invoke('lidAwake:setup'),
  remove: () => ipcRenderer.invoke('lidAwake:remove'),
  releaseNow: () => ipcRenderer.invoke('lidAwake:releaseNow')
} satisfies PreloadApi['lidAwake']

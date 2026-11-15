import { BrowserWindow, ipcMain } from 'electron'
import { parseLidAwakeConfigPatch } from '../../../shared/lid-closed-awake'
import type { LidAwakeController } from './lid-awake-controller'
import type { LidAwakeControllerDeps } from './lid-awake-controller-types'
import { removeLidHelperAndOption, setupLidHelper } from './lid-awake-helper-actions'

export function registerLidAwakeIpc(
  controller: LidAwakeController,
  deps: Pick<LidAwakeControllerDeps, 'installHelper' | 'removeHelper'>
): void {
  ipcMain.handle('lidAwake:getState', () => controller.getState())
  ipcMain.handle('lidAwake:setConfig', (_event, patch: unknown) =>
    controller.setConfig(parseLidAwakeConfigPatch(patch))
  )
  ipcMain.handle('lidAwake:setup', () => setupLidHelper(controller, deps))
  ipcMain.handle('lidAwake:remove', () => removeLidHelperAndOption(controller, deps))
  ipcMain.handle('lidAwake:releaseNow', () => controller.releaseNow())
  controller.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('lidAwake:changed', state)
      }
    }
  })
}

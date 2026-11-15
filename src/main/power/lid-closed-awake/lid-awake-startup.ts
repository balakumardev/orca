import { join } from 'node:path'
import { app, powerMonitor } from 'electron'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { getRuntimeDesktopSurface } from '../../runtime/construction/runtime-desktop-surface'
import type { AgentAwakeService } from '../agent-awake-service'
import { LidAwakeController } from './lid-awake-controller'
import type { LidAwakeControllerDeps } from './lid-awake-controller-types'
import {
  LID_AWAKE_CONFIG_FILE_NAME,
  createLidAwakeConfigWriter,
  loadLidAwakeConfig
} from './lid-awake-config-store'
import { SudoLidHoldBackend } from './lid-awake-hold-backend'
import { installLidHelper, readLidHelperSetupState, removeLidHelper } from './lid-awake-installer'
import { registerLidAwakeIpc } from './lid-awake-ipc'
import {
  lidMarkerExists,
  readBattery,
  readLidClosed,
  readSleepDisabled,
  readThermalState
} from './lid-awake-system-readers'

/** macOS desktop app only: the closed-lid hold needs a lid and a window to show its state. */
export function startLidClosedAwake(
  awake: AgentAwakeService | null,
  options: { isServeMode: boolean }
): void {
  if (process.platform !== 'darwin' || options.isServeMode || !awake) {
    return
  }
  const configPath = join(getCanonicalUserDataPath(), LID_AWAKE_CONFIG_FILE_NAME)
  const deps: LidAwakeControllerDeps = {
    backend: new SudoLidHoldBackend(),
    readBattery,
    readLidClosed,
    readSleepDisabled,
    readThermal: readThermalState,
    markerExists: lidMarkerExists,
    readSetupState: readLidHelperSetupState,
    installHelper: () => installLidHelper(),
    removeHelper: removeLidHelper,
    loadConfig: () => loadLidAwakeConfig(configPath),
    saveConfig: createLidAwakeConfigWriter(configPath),
    notify: ({ title, body }) => {
      try {
        getRuntimeDesktopSurface().showNotification({ title, body })
      } catch (error) {
        console.warn('[lid-awake] notification failed', error)
      }
    }
  }
  const controller = new LidAwakeController(deps)
  registerLidAwakeIpc(controller, deps)
  const unsubscribeService = awake.subscribe((status) => controller.setServiceStatus(status))
  controller.setServiceStatus(awake.getStatus())
  const onPowerSource = (): void => controller.evaluate(true)
  const onThermal = (): void => controller.evaluate()
  const onResume = (): void => controller.onResume()
  powerMonitor.on('on-battery', onPowerSource)
  powerMonitor.on('on-ac', onPowerSource)
  powerMonitor.on('thermal-state-change', onThermal)
  powerMonitor.on('resume', onResume)
  // will-quit is past every veto; the helper also lets go by itself when this process ends.
  app.once('will-quit', () => {
    unsubscribeService()
    powerMonitor.off('on-battery', onPowerSource)
    powerMonitor.off('on-ac', onPowerSource)
    powerMonitor.off('thermal-state-change', onThermal)
    powerMonitor.off('resume', onResume)
    controller.dispose()
  })
  void controller.start()
}

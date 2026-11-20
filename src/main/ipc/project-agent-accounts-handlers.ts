import { BrowserWindow, ipcMain } from 'electron'
import {
  PROJECT_AGENT_ACCOUNTS_CHANGED_CHANNEL,
  PROJECT_AGENT_ACCOUNTS_LIST_CHANNEL,
  PROJECT_AGENT_ACCOUNTS_SET_CHANNEL
} from '../../shared/project-agent-accounts'
import type { Store } from '../persistence/loading-store/store'
import { getProjectAgentAccountsStore } from '../project-agent-accounts/project-agent-accounts-registry'
import { setProjectAgentAccount } from '../project-agent-accounts/project-agent-account-set'

let broadcasting = false

// Subscribe on first use: registration must not touch userData before the app environment exists.
function pinsWithBroadcast(): ReturnType<typeof getProjectAgentAccountsStore> {
  const pins = getProjectAgentAccountsStore()
  if (!broadcasting) {
    broadcasting = true
    pins.subscribe((snapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(PROJECT_AGENT_ACCOUNTS_CHANGED_CHANNEL, snapshot)
        }
      }
    })
  }
  return pins
}

/** Safe to call again on macOS window recreation. */
export function registerProjectAgentAccountsHandlers(store: Store): void {
  ipcMain.removeHandler(PROJECT_AGENT_ACCOUNTS_LIST_CHANNEL)
  ipcMain.removeHandler(PROJECT_AGENT_ACCOUNTS_SET_CHANNEL)
  ipcMain.handle(PROJECT_AGENT_ACCOUNTS_LIST_CHANNEL, () => pinsWithBroadcast().list())
  ipcMain.handle(PROJECT_AGENT_ACCOUNTS_SET_CHANNEL, (_event, request: unknown) => {
    pinsWithBroadcast()
    return setProjectAgentAccount(store, request)
  })
}

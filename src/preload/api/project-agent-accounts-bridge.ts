import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import {
  PROJECT_AGENT_ACCOUNTS_CHANGED_CHANNEL,
  PROJECT_AGENT_ACCOUNTS_LIST_CHANNEL,
  PROJECT_AGENT_ACCOUNTS_SET_CHANNEL,
  type ProjectAgentAccountsSnapshot
} from '../../shared/project-agent-accounts'

export const projectAgentAccountsApi = {
  list: () => ipcRenderer.invoke(PROJECT_AGENT_ACCOUNTS_LIST_CHANNEL),
  set: (request) => ipcRenderer.invoke(PROJECT_AGENT_ACCOUNTS_SET_CHANNEL, request),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ProjectAgentAccountsSnapshot) => {
      listener(snapshot)
    }
    ipcRenderer.on(PROJECT_AGENT_ACCOUNTS_CHANGED_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(PROJECT_AGENT_ACCOUNTS_CHANGED_CHANNEL, handler)
    }
  }
} satisfies PreloadApi['projectAgentAccounts']

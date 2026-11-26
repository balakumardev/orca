import { app } from 'electron'
import {
  getDaemonEndpointFacts,
  daemonOwnsFreshPersistentPtys
} from '../../daemon/providers/lifecycle/daemon-provider-state'
import { checkDaemonHealth } from '../../daemon/health/daemon-health'
import { hasInProcessTerminalSessions } from '../../ipc/pty/provider/kill-all'
import { hasPlainSshTerminalSessions } from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'
import { hasStructuredAgentSessionProcesses } from '../../runtime/agent-session/installation/structured-agent-session-runtime'
import { isDevParentShutdownRequested } from '../../startup/configure-process'
import { mainProcessState as state } from '../../startup/main-process-state'
import { quitProcess } from '../../startup/quit/process-quit-request'
import { prepareRendererForUpdate } from '../../window/renderer-relays/native-unload-coordinator'
import { configureSourceUpdateHandoff, SourceUpdateHandoff } from './source-update-handoff'
import { holdSourceUpdateSessionStarts } from './source-update-session-admission'

// Let the owner socket acknowledge before normal quit begins closing transports.
const SOURCE_UPDATE_REPLY_GRACE_MS = 150

function blockingReason(): string | null {
  if (state.isQuitting || isDevParentShutdownRequested()) {
    return 'already-quitting'
  }
  if (hasInProcessTerminalSessions() || hasPlainSshTerminalSessions()) {
    return 'nonpersistent-terminal'
  }
  if (hasStructuredAgentSessionProcesses()) {
    return 'native-chat-busy'
  }
  if (!daemonOwnsFreshPersistentPtys()) {
    return 'daemon-unavailable'
  }
  return null
}

/** Opt in only the Mac source launch managed by the external updater. */
export function installSourceUpdateHandoff(): void {
  if (
    process.platform !== 'darwin' ||
    app.isPackaged ||
    state.isServeMode ||
    process.env.ORCA_SOURCE_UPDATE_HANDOFF !== '1'
  ) {
    return
  }
  configureSourceUpdateHandoff(
    new SourceUpdateHandoff({
      pid: process.pid,
      blockingReason,
      daemonHealthy: async () => {
        const endpoint = getDaemonEndpointFacts()
        return (
          endpoint !== null &&
          (await checkDaemonHealth(endpoint.socketPath, endpoint.tokenPath)) === 'healthy'
        )
      },
      prepareCheckpoint: async () => {
        const window = state.mainWindow
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
          return null
        }
        return prepareRendererForUpdate(window.webContents)
      },
      scheduleQuit: (commit) => {
        setTimeout(commit, SOURCE_UPDATE_REPLY_GRACE_MS)
      },
      holdSessionStarts: holdSourceUpdateSessionStarts,
      quit: quitProcess
    })
  )
}

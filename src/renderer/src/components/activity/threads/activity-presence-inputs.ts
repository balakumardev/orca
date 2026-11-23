import {
  selectActivityTerminalPresenceInputs,
  type ActivityTerminalPresenceInputs,
  type ActivityTerminalPresenceSource
} from '../events/activity-terminal-presence-inputs'
import {
  observeNativeAgentPresenceChanges,
  readNativeAgentPresence,
  type NativeAgentPresence
} from './activity-native-agent-presence'

/** Everything idle presence reads beyond the status map; the names match the event builder's arguments. */
export type ActivityPresenceInputs = ActivityTerminalPresenceInputs & {
  nativeAgentPresenceByPaneKey: NativeAgentPresence
}

let last: {
  terminal: ActivityTerminalPresenceInputs
  native: NativeAgentPresence
  result: ActivityPresenceInputs
} | null = null

/** Presence inputs for `state`; the identity holds until a process-confirmed pane or a live native chat changes. */
export function selectActivityPresenceInputs(
  state: ActivityTerminalPresenceSource
): ActivityPresenceInputs {
  const terminal = selectActivityTerminalPresenceInputs(state)
  const native = readNativeAgentPresence()
  if (last?.terminal === terminal && last.native === native) {
    return last.result
  }
  last = { terminal, native, result: { ...terminal, nativeAgentPresenceByPaneKey: native } }
  return last.result
}

/** Wake `notify` when a live native chat appears or goes away; the returned stop releases the feeds. */
export const attachActivityPresence = observeNativeAgentPresenceChanges

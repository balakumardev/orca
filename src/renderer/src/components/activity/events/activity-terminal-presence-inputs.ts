import { shallow } from 'zustand/shallow'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-authority/pane-foreground-agent'
import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

/** What terminal presence reads, kept to panes whose foreground process names an agent so unrelated title and layout writes leave it untouched. */
export type ActivityTerminalPresenceInputs = {
  paneForegroundAgentByPaneKey: Readonly<AppState['paneForegroundAgentByPaneKey']>
  terminalLayoutsByTabId: Readonly<AppState['terminalLayoutsByTabId']>
  runtimePaneTitlesByTabId: Readonly<AppState['runtimePaneTitlesByTabId']>
}

export type ActivityTerminalPresenceSource = Pick<
  AppState,
  'paneForegroundAgentByPaneKey' | 'terminalLayoutsByTabId' | 'runtimePaneTitlesByTabId'
>

function emptyTerminalPresence(): ActivityTerminalPresenceInputs {
  const paneForegroundAgentByPaneKey = {}
  const terminalLayoutsByTabId = {}
  const runtimePaneTitlesByTabId = {}
  return { paneForegroundAgentByPaneKey, terminalLayoutsByTabId, runtimePaneTitlesByTabId }
}

export const NO_TERMINAL_PRESENCE = emptyTerminalPresence()

/** A launch record or a surviving shell cannot establish that an agent process is running. */
export function isAgentProcessForeground(
  entry: PaneForegroundAgentEntry | undefined
): entry is PaneForegroundAgentEntry & { agent: NonNullable<PaneForegroundAgentEntry['agent']> } {
  return entry?.agentEvidence === 'process-read' && Boolean(entry.agent) && !entry.shellForeground
}

type ConfirmedPane = { paneKey: string; entry: PaneForegroundAgentEntry; tabId: string | null }

// Title and layout writes are far likelier than foreground changes, so the confirmed panes are found once per foreground map.
let confirmed: {
  source: ActivityTerminalPresenceSource['paneForegroundAgentByPaneKey']
  panes: ConfirmedPane[]
} | null = null
let last: (ActivityTerminalPresenceSource & { result: ActivityTerminalPresenceInputs }) | null =
  null

function confirmedPanes(
  source: ActivityTerminalPresenceSource['paneForegroundAgentByPaneKey']
): ConfirmedPane[] {
  if (confirmed?.source !== source) {
    confirmed = {
      source,
      panes: Object.entries(source)
        .filter(([, entry]) => isAgentProcessForeground(entry))
        .map(([paneKey, entry]) => ({
          paneKey,
          entry,
          tabId: parsePaneKey(paneKey)?.tabId ?? null
        }))
    }
  }
  return confirmed.panes
}

function keepIfSame<T extends object>(previous: T, next: T): T {
  return shallow(previous, next) ? previous : next
}

/** Presence inputs for `state`; the identity holds until a process-confirmed pane or its own tab's layout or titles change. */
export function selectActivityTerminalPresenceInputs(
  state: ActivityTerminalPresenceSource
): ActivityTerminalPresenceInputs {
  if (
    last?.paneForegroundAgentByPaneKey === state.paneForegroundAgentByPaneKey &&
    last.terminalLayoutsByTabId === state.terminalLayoutsByTabId &&
    last.runtimePaneTitlesByTabId === state.runtimePaneTitlesByTabId
  ) {
    return last.result
  }
  const foreground: Record<string, PaneForegroundAgentEntry> = {}
  const layouts: Record<string, AppState['terminalLayoutsByTabId'][string]> = {}
  const titles: Record<string, AppState['runtimePaneTitlesByTabId'][string]> = {}
  for (const { paneKey, entry, tabId } of confirmedPanes(state.paneForegroundAgentByPaneKey)) {
    foreground[paneKey] = entry
    if (tabId !== null && Object.hasOwn(state.terminalLayoutsByTabId, tabId)) {
      layouts[tabId] = state.terminalLayoutsByTabId[tabId]
    }
    if (tabId !== null && Object.hasOwn(state.runtimePaneTitlesByTabId, tabId)) {
      titles[tabId] = state.runtimePaneTitlesByTabId[tabId]
    }
  }
  const previous = last?.result ?? NO_TERMINAL_PRESENCE
  const terminalLayoutsByTabId = keepIfSame(previous.terminalLayoutsByTabId, layouts)
  const next = {
    paneForegroundAgentByPaneKey: keepIfSame(previous.paneForegroundAgentByPaneKey, foreground),
    terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: keepIfSame(previous.runtimePaneTitlesByTabId, titles)
  }
  last = {
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    result: shallow(previous, next) ? previous : next
  }
  return last.result
}

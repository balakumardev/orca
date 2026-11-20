import { useSyncExternalStore } from 'react'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import {
  normalizeProjectAgentAccountsSnapshot,
  type ProjectAgentAccountChoice,
  type ProjectAgentAccountProvider,
  type ProjectAgentAccountSetRequest,
  type ProjectAgentAccountsSnapshot
} from '../../../../shared/project-agent-accounts'

export type ProjectAgentAccountsView = {
  /** False until this computer's main process answers; stays false in the web client. */
  available: boolean
  snapshot: ProjectAgentAccountsSnapshot
}

const UNAVAILABLE: ProjectAgentAccountsView = { available: false, snapshot: { projects: {} } }

let view = UNAVAILABLE
let started = false
const listeners = new Set<() => void>()

function bridge(): Window['api']['projectAgentAccounts'] | undefined {
  if (typeof window === 'undefined' || isPairedWebClientWindow()) {
    return undefined
  }
  return window.api?.projectAgentAccounts
}

// The web fallback bridge answers [] or nothing; only main's own answer carries `projects`.
function isSnapshotAnswer(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'projects' in value
}

function publish(answer: unknown): void {
  if (!isSnapshotAnswer(answer)) {
    return
  }
  view = { available: true, snapshot: normalizeProjectAgentAccountsSnapshot(answer) }
  for (const listener of listeners) {
    listener()
  }
}

function ensureStarted(): void {
  const api = started ? undefined : bridge()
  if (!api) {
    return
  }
  started = true
  api.onChanged(publish)
  void api.list().then(publish, () => {})
}

export function subscribeProjectAgentAccounts(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getView(): ProjectAgentAccountsView {
  return view
}

/** For code outside React; the first call starts loading, so it reads no pins until main answers. */
export function readProjectAgentAccounts(): ProjectAgentAccountsView {
  ensureStarted()
  return view
}

export function useProjectAgentAccounts(): ProjectAgentAccountsView {
  return useSyncExternalStore(subscribeProjectAgentAccounts, getView, getView)
}

export function getProjectAgentAccountChoice(
  snapshot: ProjectAgentAccountsSnapshot,
  repoId: string,
  provider: ProjectAgentAccountProvider
): ProjectAgentAccountChoice | undefined {
  return Object.hasOwn(snapshot.projects, repoId) ? snapshot.projects[repoId][provider] : undefined
}

/** Throws main's message when the project or account cannot be pinned. */
export async function setProjectAgentAccount(
  request: ProjectAgentAccountSetRequest
): Promise<void> {
  const api = bridge()
  if (!api) {
    throw new Error('Project accounts are not available here.')
  }
  publish(await api.set(request))
}

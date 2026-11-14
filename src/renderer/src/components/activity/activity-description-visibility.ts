import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'orca-custom.activity.showDescription'

const listeners = new Set<() => void>()
let visible: boolean | null = null

function readStoredVisibility(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Whether Activity rows show the multi-line status preview under the title; hidden until opted in. */
export function getActivityDescriptionVisible(): boolean {
  visible ??= readStoredVisibility()
  return visible
}

export function setActivityDescriptionVisible(next: boolean): void {
  visible = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    // Storage can be unavailable; the choice then lasts for this window only.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useActivityDescriptionVisible(): boolean {
  return useSyncExternalStore(subscribe, getActivityDescriptionVisible, () => false)
}

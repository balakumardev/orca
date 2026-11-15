import type { LidAwakeConfig, LidAwakeSetupState } from '../../../shared/lid-closed-awake'
import type { HoldOutcome, LidHoldBackend } from './lid-awake-hold-backend'
import type { LidNotice } from './lid-awake-notices'
import type { BatteryReading, ThermalState } from './lid-awake-policy'

export const LID_LINGER_MS = 60_000
export const LID_POLL_MS = 30_000
export const LID_WATCH_MS = 5_000
export const RETRY_AFTER_FAILURE_MS = 30_000
export const UNEXPECTED_EXIT_WINDOW_MS = 60_000
export const MIN_SUMMARY_MS = 60_000
export const HOUR_MS = 3_600_000

export type BlockedPhase = 'foreign' | 'busy' | 'needs-repair'

export function blockedPhaseFor(outcome: Exclude<HoldOutcome, 'held'>): BlockedPhase {
  return outcome === 'foreign' || outcome === 'busy' ? outcome : 'needs-repair'
}

export type LidAwakeControllerDeps = {
  now?: () => number
  backend: LidHoldBackend
  readBattery: () => Promise<BatteryReading>
  readLidClosed: () => Promise<boolean | null>
  readSleepDisabled: () => Promise<boolean | null>
  readThermal: () => ThermalState
  markerExists: () => Promise<boolean>
  readSetupState: () => Promise<LidAwakeSetupState>
  installHelper: () => Promise<void>
  removeHelper: () => Promise<void>
  loadConfig: () => Promise<LidAwakeConfig>
  saveConfig: (config: LidAwakeConfig) => Promise<void>
  notify: (notice: LidNotice) => void
}

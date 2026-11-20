import type { ComputerAwakeMode } from '../../../shared/app-lifecycle/computer-awake-mode'

export type BatteryReading = {
  hasBattery: boolean
  onBattery: boolean
  /** null when a battery exists but could not be read. */
  percent: number | null
}

export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'

/** After a battery-floor stop, the percentage must climb this far above the floor before re-arming. */
export const FLOOR_RESUME_MARGIN = 5
/** The near-floor warning fires within this many points above the floor. */
export const FLOOR_WARNING_MARGIN = 5
export const THERMAL_COOL_MS = 120_000

export type ThermalLatch = { latched: boolean; coolSinceMs: number | null }

export function nextFloorLatch(prev: boolean, battery: BatteryReading, floor: number): boolean {
  if (!battery.hasBattery || !battery.onBattery) {
    return false
  }
  if (battery.percent === null) {
    return prev
  }
  if (battery.percent <= floor) {
    return true
  }
  return battery.percent > floor + FLOOR_RESUME_MARGIN ? false : prev
}

export function nextThermalLatch(
  prev: ThermalLatch,
  thermal: ThermalState,
  nowMs: number
): ThermalLatch {
  if (thermal === 'serious' || thermal === 'critical') {
    return { latched: true, coolSinceMs: null }
  }
  if (!prev.latched) {
    return prev
  }
  const coolSinceMs = prev.coolSinceMs ?? nowMs
  return nowMs - coolSinceMs >= THERMAL_COOL_MS
    ? { latched: false, coolSinceMs: null }
    : { latched: true, coolSinceMs }
}

export function isBatteryBlocked(
  battery: BatteryReading,
  floor: number,
  floorLatched: boolean
): boolean {
  if (!battery.hasBattery || !battery.onBattery) {
    return false
  }
  // An unreadable percentage on battery power fails safe.
  if (battery.percent === null) {
    return true
  }
  return floorLatched ? battery.percent <= floor + FLOOR_RESUME_MARGIN : battery.percent <= floor
}

export function isNearFloor(
  battery: BatteryReading,
  floor: number
): battery is BatteryReading & { percent: number } {
  return (
    battery.hasBattery &&
    battery.onBattery &&
    battery.percent !== null &&
    battery.percent > floor &&
    battery.percent <= floor + FLOOR_WARNING_MARGIN
  )
}

export type LidPolicyInput = {
  enabled: boolean
  helperReady: boolean
  mode: ComputerAwakeMode
  agentsActive: boolean
  userReleased: boolean
  capReached: boolean
  battery: BatteryReading
  floor: number
  floorLatched: boolean
  thermalLatched: boolean
}

export type LidBlock =
  | 'option-off'
  | 'not-ready'
  | 'mode-changed'
  | 'user'
  | 'thermal'
  | 'battery-floor'
  | 'max-hours'
  | 'agents-idle'

export type LidDecision = { hold: true } | { hold: false; blockedBy: LidBlock }

/** Safety stops outrank "agents idle" so the reason shown to the user is the safety one. */
export function decideLidHold(input: LidPolicyInput): LidDecision {
  if (!input.enabled) {
    return { hold: false, blockedBy: 'option-off' }
  }
  if (!input.helperReady) {
    return { hold: false, blockedBy: 'not-ready' }
  }
  if (input.mode !== 'auto') {
    return { hold: false, blockedBy: 'mode-changed' }
  }
  if (input.userReleased) {
    return { hold: false, blockedBy: 'user' }
  }
  if (input.thermalLatched) {
    return { hold: false, blockedBy: 'thermal' }
  }
  if (isBatteryBlocked(input.battery, input.floor, input.floorLatched)) {
    return { hold: false, blockedBy: 'battery-floor' }
  }
  if (input.capReached) {
    return { hold: false, blockedBy: 'max-hours' }
  }
  return input.agentsActive ? { hold: true } : { hold: false, blockedBy: 'agents-idle' }
}

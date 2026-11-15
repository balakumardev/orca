export const LID_AWAKE_FLOOR_DEFAULT = 30
export const LID_AWAKE_FLOOR_MIN = 10
export const LID_AWAKE_FLOOR_MAX = 90
export const LID_AWAKE_MAX_HOURS_DEFAULT = 12
export const LID_AWAKE_MAX_HOURS_MIN = 1
export const LID_AWAKE_MAX_HOURS_MAX = 48

export type LidAwakeConfig = {
  enabled: boolean
  batteryFloorPercent: number
  maxHoldHours: number
}

export const DEFAULT_LID_AWAKE_CONFIG: LidAwakeConfig = {
  enabled: false,
  batteryFloorPercent: LID_AWAKE_FLOOR_DEFAULT,
  maxHoldHours: LID_AWAKE_MAX_HOURS_DEFAULT
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** Keeps only the fields a settings change may carry; values are range-checked later. */
export function parseLidAwakeConfigPatch(value: unknown): Partial<LidAwakeConfig> {
  const patch: Partial<LidAwakeConfig> = {}
  const enabled = readField(value, 'enabled')
  const floor = readField(value, 'batteryFloorPercent')
  const hours = readField(value, 'maxHoldHours')
  if (typeof enabled === 'boolean') {
    patch.enabled = enabled
  }
  if (typeof floor === 'number') {
    patch.batteryFloorPercent = floor
  }
  if (typeof hours === 'number') {
    patch.maxHoldHours = hours
  }
  return patch
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Coerces anything read from disk or IPC into a valid config; unknown fields are dropped. */
export function normalizeLidAwakeConfig(value: unknown): LidAwakeConfig {
  return {
    enabled: readField(value, 'enabled') === true,
    batteryFloorPercent: clampInt(
      readField(value, 'batteryFloorPercent'),
      LID_AWAKE_FLOOR_DEFAULT,
      LID_AWAKE_FLOOR_MIN,
      LID_AWAKE_FLOOR_MAX
    ),
    maxHoldHours: clampInt(
      readField(value, 'maxHoldHours'),
      LID_AWAKE_MAX_HOURS_DEFAULT,
      LID_AWAKE_MAX_HOURS_MIN,
      LID_AWAKE_MAX_HOURS_MAX
    )
  }
}

/** `stale`: an older helper than the one this build embeds; it keeps working until updated. */
export type LidAwakeSetupState = 'not-installed' | 'installed' | 'stale'

export type LidAwakeReleaseReason =
  | 'battery-floor'
  | 'thermal'
  | 'max-hours'
  | 'user'
  | 'helper-failure'

export type LidAwakePhase =
  | 'off'
  | 'needs-setup'
  | 'needs-repair'
  | 'idle'
  | 'holding'
  | 'released'
  | 'foreign'
  | 'busy'

export type LidAwakeState = {
  config: LidAwakeConfig
  setup: LidAwakeSetupState
  phase: LidAwakePhase
  releaseReason: LidAwakeReleaseReason | null
  heldSinceMs: number | null
  /** When the max-hours cap will end the current hold. */
  heldUntilMs: number | null
  batteryPercent: number | null
  onBattery: boolean
  hasBattery: boolean
}

export type LidAwakeActionResult = { ok: true } | { ok: false; error: string }

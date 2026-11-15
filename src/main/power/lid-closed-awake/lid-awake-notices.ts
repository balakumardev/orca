import type { LidAwakeConfig, LidAwakeReleaseReason } from '../../../shared/lid-closed-awake'

export type LidNotice = { title: string; body: string }

export function formatHeldDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) {
    return `${minutes} min`
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export function armedNotice(config: LidAwakeConfig): LidNotice {
  return {
    title: 'Lid-closed awake is on',
    body: `While agents work, this Mac stays awake with the lid closed. It stops at ${config.batteryFloorPercent}% battery, on a thermal warning, or after ${config.maxHoldHours} h.`
  }
}

export function nearFloorNotice(percent: number, config: LidAwakeConfig): LidNotice {
  return {
    title: `Battery at ${percent}%`,
    body: `Orca will let this Mac sleep at ${config.batteryFloorPercent}%. Plug in to keep agents running with the lid closed.`
  }
}

export function releasedNotice(
  reason: Exclude<LidAwakeReleaseReason, 'user'>,
  config: LidAwakeConfig
): LidNotice {
  const consequence = 'This Mac can sleep now, so closed-lid agents will pause.'
  switch (reason) {
    case 'battery-floor':
      return {
        title: 'Lid-closed awake stopped',
        body: `Battery reached ${config.batteryFloorPercent}%. ${consequence}`
      }
    case 'thermal':
      return {
        title: 'Lid-closed awake stopped',
        body: `This Mac is running hot. ${consequence}`
      }
    case 'max-hours':
      return {
        title: 'Lid-closed awake stopped',
        body: `It ran for ${config.maxHoldHours} h, the limit you set. ${consequence}`
      }
    case 'helper-failure':
      return {
        title: 'Lid-closed awake stopped',
        body: 'The helper stopped unexpectedly. Open Settings > Agents to repair it.'
      }
  }
}

export function summaryNotice(heldMs: number, from: number | null, to: number | null): LidNotice {
  const battery = from !== null && to !== null ? ` Battery ${from}% to ${to}%.` : ''
  return {
    title: 'Lid reopened',
    body: `Held awake with the lid closed for ${formatHeldDuration(heldMs)}.${battery}`
  }
}

export const FOREIGN_NOTICE: LidNotice = {
  title: 'Lid-closed awake is not holding',
  body: 'Sleep was already disabled by something else, so Orca cannot enforce its battery, heat and time limits. It left that setting alone.'
}

export const BUSY_NOTICE: LidNotice = {
  title: 'Lid-closed awake is not holding',
  body: 'Another Orca window or build is already holding this Mac awake.'
}

export const REPAIR_NOTICE: LidNotice = {
  title: 'Lid-closed awake needs repair',
  body: 'Orca could not start its helper. Open Settings > Agents and choose Set up again.'
}

export function blockedNotice(phase: 'foreign' | 'busy' | 'needs-repair'): LidNotice {
  return phase === 'foreign' ? FOREIGN_NOTICE : phase === 'busy' ? BUSY_NOTICE : REPAIR_NOTICE
}

export const RECOVERED_NOTICE: LidNotice = {
  title: 'Normal sleep restored',
  body: 'An earlier Orca run left this Mac set to never sleep. Orca put it back.'
}

export const RECOVERY_FAILED_NOTICE: LidNotice = {
  title: 'This Mac is set to never sleep',
  body: 'An earlier Orca run left it that way and Orca could not undo it. Run: sudo pmset -a disablesleep 0'
}

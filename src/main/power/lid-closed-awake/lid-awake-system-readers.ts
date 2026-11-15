import { access } from 'node:fs/promises'
import { powerMonitor } from 'electron'
import { LID_MARKER_PATH } from './lid-awake-helper-source'
import type { BatteryReading, ThermalState } from './lid-awake-policy'
import { runLidCommand } from './lid-awake-run-command'
import { parseLidClosed, parsePmsetBattery, parseSleepDisabled } from './pmset-battery-parser'

const READ_TIMEOUT_MS = 5_000

function run(program: string, args: string[]): Promise<string | null> {
  return runLidCommand(program, args, READ_TIMEOUT_MS)
}

export async function readBattery(): Promise<BatteryReading> {
  const output = await run('/usr/bin/pmset', ['-g', 'batt'])
  // No output at all is not "no battery": report an unreadable battery so the floor fails safe.
  return output === null
    ? { hasBattery: true, onBattery: true, percent: null }
    : parsePmsetBattery(output)
}

export async function readLidClosed(): Promise<boolean | null> {
  const output = await run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'])
  return output === null ? null : parseLidClosed(output)
}

export async function readSleepDisabled(): Promise<boolean | null> {
  const output = await run('/usr/bin/pmset', ['-g'])
  return output === null ? null : parseSleepDisabled(output)
}

export function readThermalState(): ThermalState {
  try {
    return powerMonitor.getCurrentThermalState()
  } catch {
    return 'unknown'
  }
}

export async function lidMarkerExists(): Promise<boolean> {
  try {
    await access(LID_MARKER_PATH)
    return true
  } catch {
    return false
  }
}

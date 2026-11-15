import type { BatteryReading } from './lid-awake-policy'

/** Parses `pmset -g batt`. Only the internal battery counts; a UPS line is ignored. */
export function parsePmsetBattery(output: string): BatteryReading {
  const onBattery = /Now drawing from 'Battery Power'/.test(output)
  const line = output.split('\n').find((candidate) => candidate.includes('InternalBattery'))
  if (!line || /present:\s*false/.test(line)) {
    return { hasBattery: false, onBattery: false, percent: null }
  }
  const match = /(\d{1,3})%/.exec(line)
  const percent = match ? Math.min(100, Number(match[1])) : null
  return { hasBattery: true, onBattery, percent }
}

export function parseSleepDisabled(output: string): boolean | null {
  const match = /SleepDisabled\s+(\d)/.exec(output)
  return match ? match[1] === '1' : null
}

export function parseLidClosed(output: string): boolean | null {
  const match = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(output)
  return match ? match[1] === 'Yes' : null
}

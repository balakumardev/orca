import { describe, expect, it } from 'vitest'
import { parseLidClosed, parsePmsetBattery, parseSleepDisabled } from './pmset-battery-parser'

describe('parsePmsetBattery', () => {
  it('reads a charged laptop on AC power', () => {
    const output = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=22806627)\t100%; charged; 0:00 remaining present: true\n`
    expect(parsePmsetBattery(output)).toEqual({ hasBattery: true, onBattery: false, percent: 100 })
  })

  it('reads a discharging laptop', () => {
    const output = `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22806627)\t72%; discharging; 4:05 remaining present: true\n`
    expect(parsePmsetBattery(output)).toEqual({ hasBattery: true, onBattery: true, percent: 72 })
  })

  it('reports no battery on a desktop Mac', () => {
    expect(parsePmsetBattery(`Now drawing from 'AC Power'\n`)).toEqual({
      hasBattery: false,
      onBattery: false,
      percent: null
    })
  })

  it('ignores a UPS and a battery that is not present', () => {
    const ups = `Now drawing from 'AC Power'\n -CyberPower UPS (id=1)\t100%; charged; present: true\n`
    expect(parsePmsetBattery(ups).hasBattery).toBe(false)
    const absent = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=2)\t0%; present: false\n`
    expect(parsePmsetBattery(absent).hasBattery).toBe(false)
  })

  it('keeps a battery with no percentage as unreadable', () => {
    const output = `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=3)\t(no estimate); present: true\n`
    expect(parsePmsetBattery(output)).toEqual({ hasBattery: true, onBattery: true, percent: null })
  })
})

describe('parseSleepDisabled and parseLidClosed', () => {
  it('reads the SleepDisabled flag', () => {
    expect(parseSleepDisabled(' SleepDisabled\t\t1\n womp 0')).toBe(true)
    expect(parseSleepDisabled(' SleepDisabled\t\t0\n')).toBe(false)
    expect(parseSleepDisabled(' womp 0')).toBeNull()
  })

  it('reads the lid state', () => {
    expect(parseLidClosed('  | "AppleClamshellState" = Yes')).toBe(true)
    expect(parseLidClosed('  | "AppleClamshellState" = No')).toBe(false)
    expect(parseLidClosed('')).toBeNull()
  })
})

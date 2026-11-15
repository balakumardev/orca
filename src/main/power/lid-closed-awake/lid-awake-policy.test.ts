import { describe, expect, it } from 'vitest'
import {
  decideLidHold,
  nextFloorLatch,
  nextThermalLatch,
  type BatteryReading,
  type LidPolicyInput
} from './lid-awake-policy'

const onBattery = (percent: number | null): BatteryReading => ({
  hasBattery: true,
  onBattery: true,
  percent
})
const onAc: BatteryReading = { hasBattery: true, onBattery: false, percent: 20 }
const noBattery: BatteryReading = { hasBattery: false, onBattery: false, percent: null }

const base: LidPolicyInput = {
  enabled: true,
  helperReady: true,
  mode: 'auto',
  agentsActive: true,
  userReleased: false,
  capReached: false,
  battery: onBattery(80),
  floor: 30,
  floorLatched: false,
  thermalLatched: false
}

describe('decideLidHold', () => {
  it('holds while an agent works in Agent mode with a healthy battery', () => {
    expect(decideLidHold(base)).toEqual({ hold: true })
  })

  it('stops at or below the floor on battery, but not above it', () => {
    expect(decideLidHold({ ...base, battery: onBattery(30) })).toEqual({
      hold: false,
      blockedBy: 'battery-floor'
    })
    expect(decideLidHold({ ...base, battery: onBattery(31) })).toEqual({ hold: true })
  })

  it('applies no floor on AC power or on a Mac without a battery', () => {
    expect(decideLidHold({ ...base, battery: onAc })).toEqual({ hold: true })
    expect(decideLidHold({ ...base, battery: noBattery })).toEqual({ hold: true })
  })

  it('fails safe when the battery cannot be read on battery power', () => {
    expect(decideLidHold({ ...base, battery: onBattery(null) })).toEqual({
      hold: false,
      blockedBy: 'battery-floor'
    })
  })

  it('does not arm in On or Off mode', () => {
    expect(decideLidHold({ ...base, mode: 'on' })).toEqual({
      hold: false,
      blockedBy: 'mode-changed'
    })
    expect(decideLidHold({ ...base, mode: 'off' })).toEqual({
      hold: false,
      blockedBy: 'mode-changed'
    })
  })

  it('reports the safety reason before agents-idle', () => {
    expect(decideLidHold({ ...base, agentsActive: false, thermalLatched: true })).toEqual({
      hold: false,
      blockedBy: 'thermal'
    })
    expect(decideLidHold({ ...base, agentsActive: false })).toEqual({
      hold: false,
      blockedBy: 'agents-idle'
    })
  })

  it('stops for a user release and for the time cap', () => {
    expect(decideLidHold({ ...base, userReleased: true })).toEqual({
      hold: false,
      blockedBy: 'user'
    })
    expect(decideLidHold({ ...base, capReached: true })).toEqual({
      hold: false,
      blockedBy: 'max-hours'
    })
  })

  it('needs the helper and the option', () => {
    expect(decideLidHold({ ...base, enabled: false })).toEqual({
      hold: false,
      blockedBy: 'option-off'
    })
    expect(decideLidHold({ ...base, helperReady: false })).toEqual({
      hold: false,
      blockedBy: 'not-ready'
    })
  })

  it('keeps the floor latched until the battery is 5 points above it', () => {
    expect(decideLidHold({ ...base, battery: onBattery(34), floorLatched: true })).toEqual({
      hold: false,
      blockedBy: 'battery-floor'
    })
    expect(decideLidHold({ ...base, battery: onBattery(36), floorLatched: true })).toEqual({
      hold: true
    })
  })
})

describe('latches', () => {
  it('sets the floor latch at the floor and clears it above floor+5 or on AC', () => {
    expect(nextFloorLatch(false, onBattery(30), 30)).toBe(true)
    expect(nextFloorLatch(true, onBattery(34), 30)).toBe(true)
    expect(nextFloorLatch(true, onBattery(36), 30)).toBe(false)
    expect(nextFloorLatch(true, onAc, 30)).toBe(false)
  })

  it('latches on a serious thermal state and clears after 2 minutes of cool', () => {
    const hot = nextThermalLatch({ latched: false, coolSinceMs: null }, 'serious', 0)
    expect(hot).toEqual({ latched: true, coolSinceMs: null })
    const cooling = nextThermalLatch(hot, 'nominal', 1_000)
    expect(cooling).toEqual({ latched: true, coolSinceMs: 1_000 })
    expect(nextThermalLatch(cooling, 'fair', 100_000).latched).toBe(true)
    expect(nextThermalLatch(cooling, 'fair', 121_000)).toEqual({
      latched: false,
      coolSinceMs: null
    })
    expect(nextThermalLatch(cooling, 'critical', 50_000)).toEqual({
      latched: true,
      coolSinceMs: null
    })
  })
})

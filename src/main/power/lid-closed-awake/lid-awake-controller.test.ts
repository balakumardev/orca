import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LID_AWAKE_CONFIG } from '../../../shared/lid-closed-awake'
import { LidAwakeController } from './lid-awake-controller'
import type { LidAwakeControllerDeps } from './lid-awake-controller-types'
import type { HoldOutcome, LidHoldBackend } from './lid-awake-hold-backend'
import type { BatteryReading } from './lid-awake-policy'

const onBattery = (percent: number): BatteryReading => ({
  hasBattery: true,
  onBattery: true,
  percent
})

type Rig = {
  controller: LidAwakeController
  notices: string[]
  battery: { value: BatteryReading }
  holds: { count: number; released: number; failExit: () => void }
  outcome: { value: HoldOutcome }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function build(enabled = true): Rig {
  const notices: string[] = []
  const battery = { value: onBattery(80) }
  const outcome: { value: HoldOutcome } = { value: 'held' }
  const holds = { count: 0, released: 0, failExit: () => {} }
  const backend: LidHoldBackend = {
    hold: async (onUnexpectedExit) => {
      holds.count += 1
      holds.failExit = onUnexpectedExit
      if (outcome.value !== 'held') {
        return { outcome: outcome.value, session: null }
      }
      return { outcome: 'held', session: { release: async () => void (holds.released += 1) } }
    },
    reset: async () => 'clean'
  }
  const deps: LidAwakeControllerDeps = {
    backend,
    readBattery: async () => battery.value,
    readLidClosed: async () => false,
    readSleepDisabled: async () => false,
    readThermal: () => 'nominal',
    markerExists: async () => false,
    readSetupState: async () => 'installed',
    installHelper: async () => {},
    removeHelper: async () => {},
    loadConfig: async () => ({ ...DEFAULT_LID_AWAKE_CONFIG, enabled }),
    saveConfig: async () => {},
    notify: (notice) => void notices.push(notice.title)
  }
  return { controller: new LidAwakeController(deps), notices, battery, holds, outcome }
}

describe('LidAwakeController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('holds while an agent works in Agent mode and tells the owner once', async () => {
    const rig = build()
    await rig.controller.start()
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    expect(rig.controller.getState().phase).toBe('holding')
    expect(rig.holds.count).toBe(1)
    expect(rig.notices).toEqual(['Lid-closed awake is on'])
  })

  it('never holds in On mode or with the option off', async () => {
    const onMode = build()
    await onMode.controller.start()
    onMode.controller.setServiceStatus({ mode: 'on', active: true })
    await settle()
    expect(onMode.holds.count).toBe(0)
    const optionOff = build(false)
    await optionOff.controller.start()
    optionOff.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    expect(optionOff.holds.count).toBe(0)
    expect(optionOff.controller.getState().phase).toBe('off')
  })

  it('lets go at the battery floor and tells the owner', async () => {
    const rig = build()
    await rig.controller.start()
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    rig.battery.value = onBattery(30)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rig.holds.released).toBe(1)
    expect(rig.controller.getState()).toMatchObject({
      phase: 'released',
      releaseReason: 'battery-floor'
    })
    expect(rig.notices).toContain('Lid-closed awake stopped')
  })

  it('warns once when the battery is near the floor', async () => {
    const rig = build()
    await rig.controller.start()
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    rig.battery.value = onBattery(34)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rig.notices.filter((title) => title === 'Battery at 34%')).toHaveLength(1)
  })

  it('keeps the hold for 60 s after agents go idle, then releases', async () => {
    const rig = build()
    await rig.controller.start()
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    rig.controller.setServiceStatus({ mode: 'auto', active: false })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(rig.holds.released).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(rig.holds.released).toBe(1)
    expect(rig.controller.getState().phase).toBe('idle')
  })

  it('retries once silently after an unexpected helper exit, then asks for repair', async () => {
    const rig = build()
    await rig.controller.start()
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    rig.holds.failExit()
    await settle()
    expect(rig.holds.count).toBe(2)
    rig.holds.failExit()
    await settle()
    expect(rig.holds.count).toBe(2)
    expect(rig.controller.getState().phase).toBe('needs-repair')
  })

  it('shows a busy or foreign helper as not holding and does not stomp it', async () => {
    const rig = build()
    rig.outcome.value = 'foreign'
    await rig.controller.start()
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    expect(rig.controller.getState().phase).toBe('foreign')
    expect(rig.notices).toEqual(['Lid-closed awake is not holding'])
  })

  it('release now ends the hold until the next agent run', async () => {
    const rig = build()
    await rig.controller.start()
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    rig.controller.releaseNow()
    await settle()
    expect(rig.holds.released).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.holds.count).toBe(1)
    rig.controller.setServiceStatus({ mode: 'auto', active: false })
    rig.controller.setServiceStatus({ mode: 'auto', active: true })
    await settle()
    expect(rig.holds.count).toBe(2)
  })
})

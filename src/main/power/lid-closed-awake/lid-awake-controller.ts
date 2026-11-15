import type { ComputerAwakeStatus } from '../../../shared/computer-awake-mode'
import {
  DEFAULT_LID_AWAKE_CONFIG,
  normalizeLidAwakeConfig,
  type LidAwakeActionResult,
  type LidAwakeConfig,
  type LidAwakeSetupState,
  type LidAwakeState
} from '../../../shared/lid-closed-awake'
import {
  HOUR_MS,
  LID_LINGER_MS,
  LID_POLL_MS,
  LID_WATCH_MS,
  MIN_SUMMARY_MS,
  RETRY_AFTER_FAILURE_MS,
  UNEXPECTED_EXIT_WINDOW_MS,
  blockedPhaseFor,
  type BlockedPhase,
  type LidAwakeControllerDeps
} from './lid-awake-controller-types'
import type { HoldSession } from './lid-awake-hold-backend'
import { LidWatch } from './lid-awake-lid-watch'
import {
  armedNotice,
  blockedNotice,
  nearFloorNotice,
  releasedNotice,
  summaryNotice,
  type LidNotice
} from './lid-awake-notices'
import {
  decideLidHold,
  isNearFloor,
  nextFloorLatch,
  nextThermalLatch,
  type BatteryReading,
  type LidBlock,
  type LidDecision,
  type ThermalLatch
} from './lid-awake-policy'
import { StatePublisher } from './lid-awake-publisher'
import { recoverLeftoverLidFlag } from './lid-awake-recovery'
import { buildLidAwakeState } from './lid-awake-state-view'
import { NamedTimers } from './lid-awake-timers'

/** Holds the Mac awake through a lid close while Agent mode has agents working, within safety limits. */
export class LidAwakeController {
  private readonly now: () => number
  private readonly timers = new NamedTimers()
  private readonly lid = new LidWatch()
  private readonly publisher = new StatePublisher<LidAwakeState>()
  private config: LidAwakeConfig
  private setup: LidAwakeSetupState = 'not-installed'
  private status: ComputerAwakeStatus = { mode: 'off', active: false }
  private lingering = false
  private userReleased = false
  private capLatched = false
  private floorLatched = false
  private thermalLatch: ThermalLatch = { latched: false, coolSinceMs: null }
  private battery: BatteryReading = { hasBattery: false, onBattery: false, percent: null }
  private batteryReadAt = 0
  private hold: { session: HoldSession; since: number } | null = null
  private decision: LidDecision = { hold: false, blockedBy: 'option-off' }
  private blockedPhase: BlockedPhase | null = null
  private noticed = new Set<string>()
  private retryNotBefore = 0
  private lastUnexpectedExit = -Infinity
  private warnedNearFloor = false
  private chain: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: LidAwakeControllerDeps) {
    this.now = deps.now ?? Date.now
    this.config = { ...DEFAULT_LID_AWAKE_CONFIG }
  }

  async start(): Promise<void> {
    this.config = normalizeLidAwakeConfig(await this.deps.loadConfig())
    if ((await this.refreshSetupState()) !== 'not-installed' && (await this.deps.markerExists())) {
      await recoverLeftoverLidFlag(this.deps)
    }
    this.evaluate(true)
  }

  async refreshSetupState(): Promise<LidAwakeSetupState> {
    this.setup = await this.deps.readSetupState()
    this.publisher.publish(this.getState())
    return this.setup
  }

  /** Resolves once every queued evaluation, including any hold release, has finished. */
  settled(): Promise<void> {
    return this.chain
  }

  setServiceStatus(status: ComputerAwakeStatus): void {
    const wasWorking = this.isWorking()
    this.status = status
    this.timers.clear('linger')
    this.lingering = false
    if (this.isWorking()) {
      if (!wasWorking) {
        this.userReleased = false
        this.capLatched = false
      }
    } else if (wasWorking && status.mode === 'auto') {
      this.lingering = true
      this.timers.after('linger', LID_LINGER_MS, () => {
        this.lingering = false
        this.evaluate(true)
      })
    }
    this.evaluate(true)
  }

  getState(): LidAwakeState {
    return buildLidAwakeState({
      config: this.config,
      setup: this.setup,
      battery: this.battery,
      heldSince: this.hold?.since ?? null,
      decision: this.decision,
      blockedPhase: this.blockedPhase,
      interested: this.isInterested()
    })
  }

  subscribe(listener: (state: LidAwakeState) => void): () => void {
    return this.publisher.subscribe(listener)
  }

  async setConfig(patch: Partial<LidAwakeConfig>): Promise<LidAwakeActionResult> {
    const next = normalizeLidAwakeConfig({ ...this.config, ...patch })
    if (next.enabled && this.setup === 'not-installed') {
      return { ok: false, error: 'Set up the helper first.' }
    }
    if (this.config.enabled && !next.enabled) {
      this.userReleased = false
      this.capLatched = false
      this.blockedPhase = null
    }
    this.config = next
    this.timers.clear('cap')
    this.evaluate(true)
    await this.deps.saveConfig(next)
    return { ok: true }
  }

  releaseNow(): void {
    this.userReleased = true
    this.evaluate(true)
  }

  onResume(): void {
    this.evaluate(true)
    void this.watchLid(true)
  }

  dispose(): void {
    this.disposed = true
    this.timers.clearAll()
    void this.hold?.session.release()
    this.hold = null
    this.publisher.clear()
  }

  private isWorking(): boolean {
    return this.status.mode === 'auto' && this.status.active
  }

  // A linger only exists while the mode is still Agent: any status change clears it first.
  private isActive(): boolean {
    return this.isWorking() || this.lingering
  }

  private isInterested(): boolean {
    return this.config.enabled && this.setup !== 'not-installed' && this.isActive()
  }

  /** Re-decides now; power-source and thermal events call this. */
  evaluate(forceBattery = false): void {
    if (this.disposed) {
      return
    }
    this.chain = this.chain
      .then(() => this.runEvaluate(forceBattery))
      .catch((error) => console.warn('[lid-awake] evaluation failed', error))
  }

  private async runEvaluate(forceBattery: boolean): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.isInterested() && (forceBattery || this.now() - this.batteryReadAt >= LID_POLL_MS)) {
      this.battery = await this.deps.readBattery()
      this.batteryReadAt = this.now()
    }
    this.floorLatched = nextFloorLatch(
      this.floorLatched,
      this.battery,
      this.config.batteryFloorPercent
    )
    this.thermalLatch = nextThermalLatch(this.thermalLatch, this.deps.readThermal(), this.now())
    this.decision = this.decide()
    if (this.decision.hold) {
      if (!this.hold && this.now() >= this.retryNotBefore) {
        await this.engage()
      }
      this.warnNearFloor()
    } else {
      this.blockedPhase = null
      if (this.hold) {
        await this.disengage(this.decision.blockedBy)
      }
    }
    this.syncTimers()
    this.publisher.publish(this.getState())
  }

  private decide(): LidDecision {
    const maxMs = this.config.maxHoldHours * HOUR_MS
    const heldTooLong = this.hold !== null && this.now() - this.hold.since >= maxMs
    return decideLidHold({
      enabled: this.config.enabled,
      helperReady: this.setup !== 'not-installed',
      mode: this.status.mode,
      agentsActive: this.isActive(),
      userReleased: this.userReleased,
      capReached: this.capLatched || heldTooLong,
      battery: this.battery,
      floor: this.config.batteryFloorPercent,
      floorLatched: this.floorLatched,
      thermalLatched: this.thermalLatch.latched
    })
  }

  private async engage(): Promise<void> {
    const result = await this.deps.backend.hold(() => this.onUnexpectedExit())
    if (result.outcome === 'held') {
      this.hold = { session: result.session, since: this.now() }
      this.blockedPhase = null
      this.warnedNearFloor = false
      this.noticeOnce('armed', armedNotice(this.config))
      return
    }
    this.retryNotBefore = this.now() + RETRY_AFTER_FAILURE_MS
    this.blockedPhase = blockedPhaseFor(result.outcome)
    this.noticeOnce(this.blockedPhase, blockedNotice(this.blockedPhase))
  }

  private async disengage(block: LidBlock): Promise<void> {
    const hold = this.hold
    this.hold = null
    await hold?.session.release()
    for (const key of ['foreign', 'busy', 'needs-repair']) {
      this.noticed.delete(key)
    }
    if (block === 'max-hours') {
      this.capLatched = true
    }
    if (block === 'battery-floor' || block === 'thermal' || block === 'max-hours') {
      this.deps.notify(releasedNotice(block, this.config))
    }
  }

  private noticeOnce(key: string, notice: LidNotice): void {
    if (!this.noticed.has(key)) {
      this.noticed.add(key)
      this.deps.notify(notice)
    }
  }

  private onUnexpectedExit(): void {
    this.hold = null
    const now = this.now()
    const repeated = now - this.lastUnexpectedExit < UNEXPECTED_EXIT_WINDOW_MS
    this.retryNotBefore = repeated ? now + RETRY_AFTER_FAILURE_MS : 0
    if (repeated) {
      this.blockedPhase = 'needs-repair'
      this.deps.notify(releasedNotice('helper-failure', this.config))
    }
    this.lastUnexpectedExit = now
    this.evaluate(true)
  }

  private warnNearFloor(): void {
    if (
      this.hold &&
      !this.warnedNearFloor &&
      isNearFloor(this.battery, this.config.batteryFloorPercent)
    ) {
      this.warnedNearFloor = true
      this.deps.notify(nearFloorNotice(this.battery.percent, this.config))
    }
  }

  private syncTimers(): void {
    if (this.isInterested()) {
      this.timers.every('poll', LID_POLL_MS, () => this.evaluate(true))
    } else {
      this.timers.clear('poll')
    }
    if (this.hold) {
      this.timers.every('watch', LID_WATCH_MS, () => void this.watchLid(false))
      const remaining = this.hold.since + this.config.maxHoldHours * HOUR_MS - this.now()
      this.timers.after('cap', Math.max(0, remaining), () => this.evaluate())
    } else {
      this.timers.clear('cap')
      if (!this.lid.isClosed) {
        this.timers.clear('watch')
      }
    }
  }

  private async watchLid(afterResume: boolean): Promise<void> {
    if (!this.hold && !afterResume) {
      return
    }
    const ended = await this.lid.poll(this.deps.readLidClosed, this.now(), this.battery.percent)
    if (ended && ended.heldMs >= MIN_SUMMARY_MS) {
      this.battery = await this.deps.readBattery()
      this.deps.notify(summaryNotice(ended.heldMs, ended.batteryFrom, this.battery.percent))
    }
  }
}

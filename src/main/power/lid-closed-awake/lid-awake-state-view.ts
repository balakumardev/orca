import type {
  LidAwakeConfig,
  LidAwakePhase,
  LidAwakeReleaseReason,
  LidAwakeSetupState,
  LidAwakeState
} from '../../../shared/lid-closed-awake'
import { HOUR_MS, type BlockedPhase } from './lid-awake-controller-types'
import type { BatteryReading, LidBlock, LidDecision } from './lid-awake-policy'

/** The blocks the user is told about; the others (option off, agents idle, ...) are not releases. */
function toReleaseReason(block: LidBlock | null): LidAwakeReleaseReason | null {
  return block === 'battery-floor' ||
    block === 'thermal' ||
    block === 'max-hours' ||
    block === 'user'
    ? block
    : null
}

export type LidStateInputs = {
  config: LidAwakeConfig
  setup: LidAwakeSetupState
  battery: BatteryReading
  /** When the live hold began; null when nothing is held. */
  heldSince: number | null
  decision: LidDecision
  blockedPhase: BlockedPhase | null
  interested: boolean
}

function derivePhase(input: LidStateInputs): LidAwakePhase {
  if (!input.config.enabled) {
    return 'off'
  }
  if (input.setup === 'not-installed') {
    return 'needs-setup'
  }
  if (input.heldSince !== null) {
    return 'holding'
  }
  if (input.blockedPhase && input.decision.hold) {
    return input.blockedPhase
  }
  const block = input.decision.hold ? null : input.decision.blockedBy
  return toReleaseReason(block) !== null && input.interested ? 'released' : 'idle'
}

export function buildLidAwakeState(input: LidStateInputs): LidAwakeState {
  const phase = derivePhase(input)
  const block = input.decision.hold ? null : input.decision.blockedBy
  return {
    config: input.config,
    setup: input.setup,
    phase,
    releaseReason: phase === 'released' ? toReleaseReason(block) : null,
    heldSinceMs: input.heldSince,
    heldUntilMs:
      input.heldSince === null ? null : input.heldSince + input.config.maxHoldHours * HOUR_MS,
    batteryPercent: input.battery.percent,
    onBattery: input.battery.onBattery,
    hasBattery: input.battery.hasBattery
  }
}

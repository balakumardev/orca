import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

/** A captured action keeps its authority through preparation and queued RPC dispatch. */
export type RuntimeTargetGuard = {
  assertCurrent: (executionHostId?: ExecutionHostId) => void
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

/** Terminal creation and delayed fallbacks need a refusal predicate rather than a thrown error. */
export function isRuntimeTargetCurrent(
  guard: RuntimeTargetGuard | undefined,
  executionHostId?: ExecutionHostId
): boolean {
  try {
    guard?.assertCurrent(executionHostId)
    return true
  } catch {
    return false
  }
}

/** The RPC options that fence a queued call to the connection the guard captured. */
export function runtimeTargetGuardRequestOptions(
  guard: RuntimeTargetGuard | undefined,
  executionHostId?: ExecutionHostId
): {
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
  beforeSend?: () => void
} {
  if (!guard) {
    return {}
  }
  return {
    expectedEnvironmentPairingRevision: guard.expectedEnvironmentPairingRevision,
    expectedEnvironmentRuntimeId: guard.expectedEnvironmentRuntimeId,
    beforeSend: () => guard.assertCurrent(executionHostId)
  }
}

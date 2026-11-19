import type { StructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-intent'
import type { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { RuntimeConnectionChangedBeforeSendError } from '@/runtime/rpc/calls/runtime-rpc-result'

type CallOptions = NonNullable<Parameters<typeof callStructuredAgentSession>[3]>

/** Keep both the original selection and any later fork capability proof at the sending boundary. */
export function structuredLaunchHostOptions(
  intent: StructuredAgentSessionLaunchIntent,
  forkOptions?: CallOptions
): CallOptions | undefined {
  const guard = intent.targetGuard
  if (!guard) {
    return forkOptions
  }
  return {
    ...forkOptions,
    expectedEnvironmentPairingRevision:
      guard.expectedEnvironmentPairingRevision ?? forkOptions?.expectedEnvironmentPairingRevision,
    expectedEnvironmentRuntimeId:
      guard.expectedEnvironmentRuntimeId ?? forkOptions?.expectedEnvironmentRuntimeId,
    beforeSend: () => {
      try {
        guard.assertCurrent(intent.executionHostId)
        if (
          forkOptions?.expectedEnvironmentRuntimeId &&
          guard.expectedEnvironmentRuntimeId &&
          forkOptions.expectedEnvironmentRuntimeId !== guard.expectedEnvironmentRuntimeId
        ) {
          throw new Error('The fork proof belongs to a different runtime.')
        }
      } catch (error) {
        throw new RuntimeConnectionChangedBeforeSendError(
          error instanceof Error ? error.message : 'The selected computer changed.'
        )
      }
    }
  }
}

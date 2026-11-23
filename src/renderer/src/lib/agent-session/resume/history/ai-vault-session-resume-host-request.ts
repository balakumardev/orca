import { parseRoutableExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type {
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeTargetGuard } from '@/runtime/rpc/targets/runtime-target-guard'
import { waitForPromiseWithSignal } from '../../../../../../shared/concurrency/abort-signal-reason'

/** Preparation may copy transcripts, so its queued request keeps the search-selected host too. */
export function guardedAiVaultResumeRequest(
  executionHostId: string,
  guard?: RuntimeTargetGuard,
  signal?: AbortSignal
):
  | ((args: AiVaultPrepareSessionResumeRequest) => Promise<AiVaultPrepareSessionResumeResult>)
  | undefined {
  const host = parseRoutableExecutionHostId(executionHostId)
  if (!guard || host?.kind !== 'runtime') {
    return undefined
  }
  return (args) => {
    signal?.throwIfAborted()
    // Keep the fenced one-shot queue; passing signal to callRuntimeRpc switches to subscriptions.
    const prepared = callRuntimeRpc<AiVaultPrepareSessionResumeResult>(
      { kind: 'environment', environmentId: host.environmentId },
      'aiVault.prepareSessionResume',
      args,
      {
        expectedEnvironmentPairingRevision: guard.expectedEnvironmentPairingRevision,
        expectedEnvironmentRuntimeId: guard.expectedEnvironmentRuntimeId,
        beforeSend: () => {
          signal?.throwIfAborted()
          guard.assertCurrent(host.id)
        }
      }
    )
    return waitForPromiseWithSignal(prepared, signal)
  }
}

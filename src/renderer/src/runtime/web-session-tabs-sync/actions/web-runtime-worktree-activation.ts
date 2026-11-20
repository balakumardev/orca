import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { useAppStore } from '../../../store/index'
import { unwrapRuntimeRpcResult } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import type { RuntimeTargetGuard } from '../../rpc/targets/runtime-target-guard'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from '../identity/web-runtime-session-environment'
import {
  refreshWebRuntimeSessionTabsSnapshot,
  scheduleRuntimeWorktreeRecoveryRefresh
} from '../inventory/web-runtime-session-snapshot'

export async function activateWebRuntimeSessionWorktree(args: {
  worktreeId: string
  environmentId?: string | null
  targetGuard?: RuntimeTargetGuard
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const guard = args.targetGuard
  // A reveal is a host mutation too; preserve the original fence through the main queue.
  const callEnvironment = captureRuntimeEnvironmentCall(
    environmentId,
    guard?.expectedEnvironmentPairingRevision ?? intentOwner.pairingRevision,
    guard
      ? () => {
          guard.assertCurrent()
          return true
        }
      : undefined,
    guard?.expectedEnvironmentRuntimeId
  )

  try {
    const response = await callEnvironment({
      method: 'worktree.activate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        // Why: notifyClients:false keeps navigation local when this client reaches an older host.
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
    guard?.assertCurrent()
    // Why: a restarted HUB can recover its SSH pane after this client's subscription replayed an empty startup snapshot.
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
      acceptCurrentSnapshot: true
    })
    guard?.assertCurrent()
    // Why: HUB reachability can precede its nested SSH relay; bounded owner-scoped re-lists converge without asking the paired client to connect SSH itself.
    scheduleRuntimeWorktreeRecoveryRefresh(
      environmentId,
      args.worktreeId,
      intentOwner.pairingRevision
    )
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to activate worktree:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

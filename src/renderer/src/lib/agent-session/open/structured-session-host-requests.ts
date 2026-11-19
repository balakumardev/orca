import {
  structuredSessionOpenFailure,
  type StructuredSessionOpenTarget,
  type StructuredSessionOpenFailure
} from '../../../../../shared/open-structured-agent-session'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../../workspace/ownership/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { isRuntimeCompatBlockError } from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

/** Reveal, refresh, and party requests retain the same bounded restoration wait. */
export const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Failure to answer never proves a chat is gone; keep retry, missing, and update remedies distinct. */
export type StructuredSessionRevealOutcome =
  | StructuredSessionOpenTarget
  | StructuredSessionOpenFailure
  | 'gone'
  | 'host-cannot-open'
  | 'unreachable'

/** Only revealed promises a tab; preserve distinct retry/missing/update outcomes for the other replies. */
export async function revealStructuredSession(target: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
  current?: () => boolean
  expectedEnvironmentRuntimeId?: string
}): Promise<StructuredSessionRevealOutcome> {
  if (target.current?.() === false) {
    return 'unreachable'
  }
  const host =
    target.target ??
    runtimeTargetForOwnerEnvironment(
      runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), target.worktreeId)
    )
  // Probe the answering paired host’s build; the local host shares this build and needs no probe.
  if (host.kind === 'environment') {
    let supported: boolean
    try {
      // Race even cached probe promises: an older unbounded probe must not hold the session’s in-flight guard forever.
      supported = await withStructuredSessionRestoreTimeout(
        runtimeEnvironmentSupportsCapability(
          host.environmentId,
          STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      )
    } catch (error) {
      // Only a version block proves age; other probe failures say nothing about the chat (as in remote-agent-session-launch).
      return isRuntimeCompatBlockError(error) ? 'host-cannot-open' : 'unreachable'
    }
    if (!supported) {
      return 'host-cannot-open'
    }
  }
  let result: AgentSessionRevealReply | undefined
  try {
    result = await withStructuredSessionRestoreTimeout(
      callRuntimeRpc<AgentSessionRevealReply>(
        host,
        'agentSession.reveal',
        { sessionId: target.sessionId },
        {
          timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
          // A capability probe cannot authorize a queued reveal on a replacement runtime.
          expectedEnvironmentRuntimeId: target.expectedEnvironmentRuntimeId,
          // Compatibility negotiation can outlive the search result's pairing.
          beforeSend: () => {
            if (target.current?.() === false) {
              throw new Error('structured_session_host_changed')
            }
          }
        }
      )
    )
  } catch {
    return 'unreachable'
  }
  if (result?.ok === true) {
    return { sessionId: result.sessionId, worktreeId: result.workspaceId, agent: result.agent }
  }
  // Distinguish a missing record from an existing record the host cannot open; only the first means gone.
  if (result?.refusal?.code === 'agent_session_workspace_removed') {
    return structuredSessionOpenFailure(result.refusal)
  }
  return result?.refusal?.code === 'agent_session_identity_required'
    ? 'gone'
    : result?.refusal?.code === 'agent_session_operation_unknown'
      ? 'unreachable'
      : 'host-cannot-open'
}

type AgentSessionRevealReply =
  | { ok: true; sessionId: string; workspaceId: string; agent: string }
  | { ok: false; refusal: { code?: string; details?: unknown } }

/** Restored tabs keep using their owner's existing inventory publication path. */
export async function refreshStructuredSessionTabs(
  worktreeId: string,
  target?: RuntimeClientTarget,
  current?: () => boolean,
  expectedEnvironmentRuntimeId?: string
): Promise<void> {
  if (current?.() === false) {
    return
  }
  const state = useAppStore.getState()
  const host =
    target ??
    runtimeTargetForOwnerEnvironment(runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId))
  if (host.kind === 'local') {
    await withStructuredSessionRestoreTimeout(refreshLocalStructuredSessionWorktreeTabs(worktreeId))
    return
  }
  // Paired inventories arrive through their existing host-scoped subscription.
  await withStructuredSessionRestoreTimeout(
    callRuntimeRpc(
      host,
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      {
        timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
        expectedEnvironmentRuntimeId,
        beforeSend: () => {
          if (current?.() === false) {
            throw new Error('structured_session_host_changed')
          }
        }
      }
    )
  )
}

/** Even a retained unbounded probe must settle before the shared restoration deadline. */
export async function withStructuredSessionRestoreTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('structured_session_restore_timeout')),
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

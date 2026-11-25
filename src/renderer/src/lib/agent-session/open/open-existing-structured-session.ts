import {
  openStructuredAgentSession,
  structuredSessionOpenFailure
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult,
  StructuredSessionOpenDeps,
  StructuredSessionOpenTab
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import {
  findStructuredAgentSessionTab,
  activateStructuredAgentSessionById
} from '../structured-agent-session-tab-activation'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../../workspace/ownership/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { OrchestrationPartyLocationResult } from '../../../../../shared/orchestration/orchestration-caller-status'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
  refreshStructuredSessionTabs,
  revealStructuredSession,
  withStructuredSessionRestoreTimeout,
  type StructuredSessionRevealOutcome
} from './structured-session-host-requests'

export { revealStructuredSession, type StructuredSessionRevealOutcome }

export type StructuredSessionOpenAdapterDeps = {
  activate: typeof activateStructuredAgentSessionById
  tabs: (
    target: { sessionId: string; worktreeId: string },
    owner: RuntimeClientTarget
  ) => readonly StructuredSessionOpenTab[]
  refresh: (
    worktreeId: string,
    target?: RuntimeClientTarget,
    current?: () => boolean,
    expectedEnvironmentRuntimeId?: string
  ) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
    target?: RuntimeClientTarget
    current?: () => boolean
    expectedEnvironmentRuntimeId?: string
  }) => Promise<StructuredSessionRevealOutcome>
}

const defaultDeps: StructuredSessionOpenAdapterDeps = {
  activate: activateStructuredAgentSessionById,
  tabs: (target, owner) => {
    const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
      workspaceId: target.worktreeId,
      sessionId: target.sessionId,
      target: owner
    })
    return tab ? [{ id: tab.id, sessionId: tab.entityId, agent: tab.agentSessionAgent }] : []
  },
  refresh: refreshStructuredSessionTabs,
  reveal: revealStructuredSession
}

export type StructuredSessionOpenOutcome = 'activated' | 'gone' | 'host-cannot-open' | 'unavailable'

export function structuredSessionOpenOutcome(
  result: StructuredSessionOpenResult
): StructuredSessionOpenOutcome {
  if (result.kind === 'opened') {
    return 'activated'
  }
  if (result.kind === 'failed' && result.failure.reason === 'gone') {
    return 'gone'
  }
  if (result.kind === 'failed' && result.failure.reason === 'unsupported') {
    return 'host-cannot-open'
  }
  return 'unavailable'
}

type DesktopInteractionOptions = {
  target?: RuntimeClientTarget
  deps?: StructuredSessionOpenAdapterDeps
  locate?: StructuredSessionOpenDeps['locate']
  initialize?: () => boolean
  current?: () => boolean
  expectedEnvironmentRuntimeId?: string
  present: (result: StructuredSessionOpenResult, owner: RuntimeClientTarget) => void
  onError?: () => void
}

const activationsInFlight = new Map<
  string,
  {
    promise: Promise<StructuredSessionOpenResult>
    current?: () => boolean
  }
>()

/** Admission precedes every owner effect; joiners only observe the rich settlement. */
export async function openDesktopStructuredSessionInteraction(
  source: StructuredSessionOpenSource,
  options: DesktopInteractionOptions
): Promise<StructuredSessionOpenResult> {
  if (options.current?.() === false) {
    return { kind: 'superseded' }
  }
  const seedWorkspace =
    source.kind === 'history'
      ? source.structuredSession.workspaceId
      : source.kind === 'notification'
        ? source.worktreeId
        : source.fallback?.worktreeId
  let owner: RuntimeClientTarget
  try {
    owner =
      options.target ??
      runtimeTargetForOwnerEnvironment(
        runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), seedWorkspace ?? '')
      )
  } catch (error) {
    options.onError?.()
    throw error
  }
  const key =
    source.kind === 'history'
      ? `${executionHostIdForStructuredTarget(owner)}\0${source.structuredSession.workspaceId}\0${source.structuredSession.sessionId}`
      : undefined
  const pending = key === undefined ? undefined : activationsInFlight.get(key)
  if (pending && pending.current?.() !== false) {
    return pending.promise
  }
  let initialized = true
  const execute = async (): Promise<StructuredSessionOpenResult> => {
    if (options.current?.() === false) {
      return { kind: 'superseded' }
    }
    initialized = options.initialize?.() !== false
    return initialized
      ? executeDesktopStructuredSession(
          source,
          owner,
          options.deps ?? defaultDeps,
          options.locate,
          options.current,
          options.expectedEnvironmentRuntimeId
        )
      : {
          kind: 'failed' as const,
          failure: { reason: 'unreachable' as const, beforeEffects: true }
        }
  }
  const activation = (key === undefined ? execute() : Promise.resolve().then(execute))
    .then(
      (result) => {
        if (options.current?.() === false) {
          return { kind: 'superseded' as const }
        }
        if (initialized) {
          options.present(result, owner)
        }
        return result
      },
      (error: unknown) => {
        options.onError?.()
        throw error
      }
    )
    .finally(() => {
      if (key !== undefined && activationsInFlight.get(key)?.promise === activation) {
        activationsInFlight.delete(key)
      }
    })
  if (key !== undefined) {
    // A replacement pairing never joins an earlier open still waiting on the retired host.
    activationsInFlight.set(key, { promise: activation, current: options.current })
  }
  return activation
}

export async function openExistingStructuredSession(
  structured: { workspaceId: string; sessionId: string },
  options: Omit<DesktopInteractionOptions, 'present'> & {
    present: (outcome: StructuredSessionOpenOutcome, result: StructuredSessionOpenResult) => void
  }
): Promise<StructuredSessionOpenOutcome> {
  const result = await openDesktopStructuredSessionInteraction(
    { kind: 'history', structuredSession: structured },
    { ...options, present: (value) => options.present(structuredSessionOpenOutcome(value), value) }
  )
  return structuredSessionOpenOutcome(result)
}

async function executeDesktopStructuredSession(
  source: StructuredSessionOpenSource,
  owner: RuntimeClientTarget,
  deps: StructuredSessionOpenAdapterDeps,
  locate?: StructuredSessionOpenDeps['locate'],
  current?: () => boolean,
  expectedEnvironmentRuntimeId?: string
): Promise<StructuredSessionOpenResult> {
  const beforeSend = () => {
    if (current?.() === false) {
      throw new Error('structured_session_host_changed')
    }
  }
  const party =
    (method: 'orchestration.partyLocation' | 'orchestration.partyOpen') =>
    async (address: string, messageIds: readonly string[]) => {
      try {
        return await withStructuredSessionRestoreTimeout(
          callRuntimeRpc<OrchestrationPartyLocationResult>(
            owner,
            method,
            { address, ...(messageIds.length ? { messageIds } : {}) },
            {
              timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
              // Unguarded callers retain their existing RPC options.
              ...(current ? { beforeSend } : {}),
              ...(expectedEnvironmentRuntimeId ? { expectedEnvironmentRuntimeId } : {})
            }
          )
        )
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    }
  return openStructuredAgentSession(source, {
    current,
    locate: locate ?? party('orchestration.partyLocation'),
    ...(locate ? {} : { open: party('orchestration.partyOpen') }),
    tabs: (target) => deps.tabs(target, owner),
    activate: (tab, target) =>
      deps
        .tabs(target, owner)
        .some((row) => row.id === tab.id && row.sessionId === target.sessionId) &&
      deps.activate({ ...target, target: owner, current, expectedEnvironmentRuntimeId }),
    refresh: (target) =>
      current?.() === false
        ? Promise.resolve()
        : deps.refresh(target.worktreeId, owner, current, expectedEnvironmentRuntimeId),
    reveal: async (target) => {
      const outcome = await deps.reveal({
        ...target,
        target: owner,
        current,
        expectedEnvironmentRuntimeId
      })
      return typeof outcome === 'object'
        ? outcome
        : {
            reason: outcome === 'host-cannot-open' ? 'unsupported' : outcome,
            beforeEffects: outcome !== 'unreachable'
          }
    }
  })
}

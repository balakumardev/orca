import {
  openStructuredAgentSession,
  structuredSessionOpenFailure
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult,
  StructuredSessionOpenDeps,
  StructuredSessionOpenInventoryRecheck,
  StructuredSessionOpenTarget,
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
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { throwIfSignalAborted } from '../../../../../shared/concurrency/abort-signal-reason'
import type { OrchestrationPartyLocationResult } from '../../../../../shared/orchestration/orchestration-caller-status'
import {
  revealStructuredSession as revealStructuredSessionWithSignal,
  STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
  withStructuredSessionRestoreTimeout
} from './structured-session-restore'
import {
  refreshStructuredSessionTabs,
  revealStructuredSession,
  type StructuredSessionRevealOutcome
} from './structured-session-host-requests'
import { pairedBotThreadRecovery } from './paired-bot-thread-recovery'

export { revealStructuredSession, type StructuredSessionRevealOutcome }

export type StructuredSessionOpenAdapterDeps = {
  activate: typeof activateStructuredAgentSessionById
  locate?: StructuredSessionOpenDeps['locate']
  tabs: (
    target: { sessionId: string; worktreeId: string },
    owner: RuntimeClientTarget
  ) => readonly StructuredSessionOpenTab[]
  refresh: (
    target: StructuredSessionOpenTarget,
    owner: RuntimeClientTarget,
    authority?: { current?: () => boolean; expectedEnvironmentRuntimeId?: string }
  ) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
    target?: RuntimeClientTarget
    current?: () => boolean
    expectedEnvironmentRuntimeId?: string
  }) => Promise<StructuredSessionRevealOutcome | StructuredSessionOpenInventoryRecheck>
  current?: () => boolean
  signal?: AbortSignal
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
  refresh: (target, owner, authority) =>
    refreshStructuredSessionTabs(
      target.worktreeId,
      owner,
      authority?.current,
      authority?.expectedEnvironmentRuntimeId
    ),
  reveal: revealStructuredSession
}

export function pairedBotThreadOpenDeps(
  linkedWorkspaceId: string,
  linkedSessionId: string,
  target: RuntimeClientTarget,
  signal: AbortSignal,
  current: () => boolean,
  activate: StructuredSessionOpenAdapterDeps['activate']
): StructuredSessionOpenAdapterDeps {
  const recovery =
    target.kind === 'environment'
      ? pairedBotThreadRecovery(target, linkedWorkspaceId, linkedSessionId, signal)
      : undefined
  return {
    ...defaultDeps,
    current,
    signal,
    activate,
    locate: recovery?.locate,
    reveal:
      recovery?.reveal ?? ((target) => revealStructuredSessionWithSignal({ ...target, signal })),
    refresh: async ({ worktreeId, sessionId }, owner) => {
      if (await recovery?.resumePending()) {
        return
      }
      if (!current()) {
        return
      }
      if (owner.kind === 'environment' && worktreeId === linkedWorkspaceId) {
        const timeout = new AbortController()
        const requestSignal = AbortSignal.any([signal, timeout.signal])
        await withStructuredSessionRestoreTimeout(
          import('@/runtime/web-session-tabs-sync/inventory/paired-chat-tab-reply').then(
            ({ readPairedChatTab }) =>
              readPairedChatTab({
                environmentId: owner.environmentId,
                worktreeId,
                sessionId,
                timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
                minimumReceivedFrame: recovery?.minimumInventoryFrame(),
                signal: requestSignal,
                current
              })
          ),
          { onTimeout: () => timeout.abort() }
        )
      } else {
        await defaultDeps.refresh({ worktreeId, sessionId }, owner)
      }
    }
  }
}

export type StructuredSessionOpenOutcome = 'activated' | 'gone' | 'host-cannot-open' | 'unavailable'

export function structuredSessionOpenOutcome(
  result: StructuredSessionOpenResult
): StructuredSessionOpenOutcome {
  if (result.kind === 'opened') {
    return 'activated'
  }
  const reason = result.kind === 'failed' ? result.failure.reason : null
  return reason === 'gone' ? 'gone' : reason === 'unsupported' ? 'host-cannot-open' : 'unavailable'
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

type InFlightActivation = { promise: Promise<StructuredSessionOpenResult>; current?: () => boolean }

const activationsInFlight = new Map<string, InFlightActivation>()

/** Admission precedes every owner effect; joiners only observe the rich settlement. */
export async function openDesktopStructuredSessionInteraction(
  source: StructuredSessionOpenSource,
  options: DesktopInteractionOptions
): Promise<StructuredSessionOpenResult> {
  const deps = options.deps ?? defaultDeps
  // The caller's captured authority and a paired deps' own pairing must both still hold.
  const isCurrent = (): boolean => options.current?.() !== false && (deps.current?.() ?? true)
  if (!isCurrent()) {
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
    source.kind === 'history' && !options.deps?.signal
      ? `${executionHostIdForStructuredTarget(owner)}\0${source.structuredSession.workspaceId}\0${source.structuredSession.sessionId}`
      : undefined
  const pending = key === undefined ? undefined : activationsInFlight.get(key)
  if (pending && pending.current?.() !== false) {
    return pending.promise
  }
  let initialized = true
  const execute = async (): Promise<StructuredSessionOpenResult> => {
    if (!isCurrent()) {
      return { kind: 'superseded' }
    }
    initialized = options.initialize?.() !== false
    return initialized
      ? executeDesktopStructuredSession(
          source,
          owner,
          deps,
          isCurrent,
          options.locate,
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
        if (!isCurrent()) {
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
    activationsInFlight.set(key, { promise: activation, current: isCurrent })
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
  isCurrent: () => boolean,
  locate?: StructuredSessionOpenDeps['locate'],
  expectedEnvironmentRuntimeId?: string
): Promise<StructuredSessionOpenResult> {
  const authority = { current: isCurrent, expectedEnvironmentRuntimeId }
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
              beforeSend: () => {
                throwIfSignalAborted(deps.signal)
                // A replaced pairing must never reach the retired host's record.
                if (!isCurrent()) {
                  throw new Error('structured_session_host_changed')
                }
              },
              ...(expectedEnvironmentRuntimeId ? { expectedEnvironmentRuntimeId } : {})
            }
          ),
          { signal: deps.signal }
        )
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    }
  return openStructuredAgentSession(source, {
    current: isCurrent,
    locate: locate ?? deps.locate ?? party('orchestration.partyLocation'),
    ...(locate ? {} : { open: party('orchestration.partyOpen') }),
    tabs: (target) => deps.tabs(target, owner),
    activate: (tab, target) =>
      deps
        .tabs(target, owner)
        .some((row) => row.id === tab.id && row.sessionId === target.sessionId) &&
      deps.activate({ ...target, target: owner, ...authority }),
    refresh: (target) => (isCurrent() ? deps.refresh(target, owner, authority) : Promise.resolve()),
    reveal: async (target) => {
      const outcome = await deps.reveal({ ...target, target: owner, ...authority })
      return typeof outcome === 'object'
        ? outcome
        : {
            reason: outcome === 'host-cannot-open' ? 'unsupported' : outcome,
            beforeEffects: outcome !== 'unreachable'
          }
    }
  })
}

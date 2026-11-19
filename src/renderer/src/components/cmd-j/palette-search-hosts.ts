import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { readLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import {
  expandEquivalentExecutionHostIds,
  getManagedOrcadSshTargetId
} from '../../../../shared/execution-host/managed-orcad-execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { translateHostDisplayLabel } from '../sidebar/execution-host-label'
import type { RuntimeTargetGuard } from '@/runtime/rpc/targets/runtime-target-guard'
import { translate } from '@/i18n/i18n'

export type PaletteSearchHost = {
  executionHostId: ExecutionHostId
  label: string
  runtimeEnvironmentId: string | null
  pairingRevision: number | null
  runtimeId: string | null
  connectionGeneration: number | null
  capabilities: readonly string[]
  key: string
}

/** Search only configured, live authorities; focused-host defaults never relocate this computer. */
export function getPaletteSearchHosts(
  state: AppState,
  hostIds?: readonly string[]
): readonly PaletteSearchHost[] {
  const environments = state.runtimeEnvironments.filter(
    (environment) => !state.removedRuntimeEnvironmentIds?.has(environment.id)
  )
  const byId = new Map(environments.map((environment) => [environment.id, environment]))
  const statuses = new Map([...state.runtimeStatusByEnvironmentId].filter(([id]) => byId.has(id)))
  const registry = buildExecutionHostRegistry({
    repos: [],
    settings: null,
    hostSource: 'configured-only',
    runtimeEnvironments: environments,
    runtimeStatusByEnvironmentId: statuses,
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  })
  const selected = hostIds?.length
    ? new Set(
        expandEquivalentExecutionHostIds(
          registry,
          hostIds.flatMap((id) => {
            const host = parseExecutionHostId(id)
            return host ? [host.id] : []
          })
        )
      )
    : null
  const seenServers = new Set<string>()
  const hosts: PaletteSearchHost[] = []
  for (const host of registry) {
    if (selected && !selected.has(host.id)) {
      continue
    }
    if (host.kind === 'local') {
      hosts.push({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        label: translateHostDisplayLabel(host),
        runtimeEnvironmentId: null,
        pairingRevision: null,
        runtimeId: null,
        connectionGeneration: null,
        capabilities: readLocalRuntimeCapabilities(),
        key: LOCAL_EXECUTION_HOST_ID
      })
      continue
    }
    const parsed = parseExecutionHostId(host.id)
    if (parsed?.kind !== 'runtime' || host.health !== 'available') {
      continue
    }
    const environment = byId.get(parsed.environmentId)
    const entry = statuses.get(parsed.environmentId)
    const status = entry?.status
    if (!environment || !entry || !status?.runtimeId || !status.capabilities?.length) {
      continue
    }
    const pairingRevision = environment.pairingRevision ?? environment.createdAt
    const snapshot = entry.snapshot
    // Retained compatible metadata alone does not prove a currently connected authority.
    if (
      !snapshot ||
      snapshot.retired ||
      snapshot.verification !== 'verified' ||
      snapshot.transport !== 'ready' ||
      snapshot.pairingRevision !== pairingRevision ||
      snapshot.environmentId !== environment.id ||
      snapshot.status?.runtimeId !== status.runtimeId ||
      (environment.runtimeId && environment.runtimeId !== status.runtimeId)
    ) {
      continue
    }
    // Runtime identity, a proven host key, or managed deployment links collapse aliases, never names.
    const sshTargetId = getManagedOrcadSshTargetId(environment)
    const serverKeys = [
      `runtime:${status.runtimeId}`,
      ...(environment.hostKeyFingerprint ? [`key:${environment.hostKeyFingerprint}`] : []),
      ...(sshTargetId ? [`ssh:${sshTargetId}`] : [])
    ]
    if (serverKeys.some((key) => seenServers.has(key))) {
      continue
    }
    serverKeys.forEach((key) => seenServers.add(key))
    const connectionGeneration = entry.connectionGeneration ?? null
    // Search selections expire on reconnect without retiring the same-runtime session mirror.
    const hostContactEpoch = entry.hostContactEpoch ?? 0
    hosts.push({
      executionHostId: parsed.id,
      label: translateHostDisplayLabel(host),
      runtimeEnvironmentId: environment.id,
      pairingRevision,
      runtimeId: status.runtimeId,
      connectionGeneration,
      capabilities: status.capabilities,
      key: JSON.stringify([
        parsed.id,
        pairingRevision,
        status.runtimeId,
        connectionGeneration,
        hostContactEpoch
      ])
    })
  }
  return hosts
}

/** An action keeps the queried authority even if selection, pairing, or connection changes. */
export function isPaletteSearchHostCurrent(
  host: PaletteSearchHost,
  state: AppState = useAppStore.getState()
): boolean {
  return getPaletteSearchHosts(state, [host.executionHostId]).some(
    (current) => current.executionHostId === host.executionHostId && current.key === host.key
  )
}

/** Creation and conversation resume share the authority captured by the search result. */
export function paletteSearchHostGuard(
  host: PaletteSearchHost | undefined
): RuntimeTargetGuard | undefined {
  if (!host) {
    return undefined
  }
  return {
    expectedEnvironmentPairingRevision: host.pairingRevision ?? undefined,
    expectedEnvironmentRuntimeId: host.runtimeId ?? undefined,
    assertCurrent: (executionHostId) => {
      if (
        (executionHostId && executionHostId !== host.executionHostId) ||
        !isPaletteSearchHostCurrent(host)
      ) {
        throw new Error(
          translate(
            'auto.components.WorktreeJumpPalette.folderHostChanged',
            'The computer for this folder changed or disconnected. Search again.'
          )
        )
      }
    }
  }
}

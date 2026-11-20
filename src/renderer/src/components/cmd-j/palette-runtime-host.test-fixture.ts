import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'

export function paletteRuntimeEnvironment(id = 'builder'): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: `runtime-${id}`,
    endpoints: [{ id: 'ws', kind: 'websocket', label: 'Server', endpoint: 'ws://127.0.0.1:7001' }],
    preferredEndpointId: 'ws'
  }
}

export function paletteRuntimeStatus(
  environment: PublicKnownRuntimeEnvironment,
  capabilities: string[] = ['folderSearch.v1', 'aiVault.v1']
): RuntimeEnvironmentStatus {
  const status = {
    runtimeId: environment.runtimeId ?? 'runtime-builder',
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 2,
    capabilities,
    hostPlatform: 'linux' as const,
    rendererGraphEpoch: 0,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
  return {
    status,
    checkedAt: 1,
    connectionGeneration: 1,
    snapshot: {
      environmentId: environment.id,
      pairingRevision: environment.pairingRevision ?? 1,
      sequence: 1,
      checkedAt: 1,
      status,
      verification: 'verified',
      transport: 'ready'
    }
  }
}

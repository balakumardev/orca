import { useEffect, useState } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { loadHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import {
  acquire,
  resource
} from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import { isPaletteSearchHostCurrent, type PaletteSearchHost } from './palette-search-hosts'
import {
  ensureLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilitiesKnown
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'

/**
 * Each recording host supplies its catalog and launch defaults while its results are visible.
 */
export function usePaletteSessionResumeCatalogs(
  active: boolean,
  hosts: readonly PaletteSearchHost[]
): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    let disposed = false
    const stops: (() => void)[] = []
    for (const host of hosts) {
      const publish = () => {
        if (!disposed && isPaletteSearchHostCurrent(host)) {
          setVersion((previous) => previous + 1)
        }
      }
      const load = (capabilities: readonly string[] | null): void => {
        if (!disposed && isPaletteSearchHostCurrent(host)) {
          void loadHostStructuredAgents(host.executionHostId, capabilities, host.runtimeId).then(
            publish
          )
        }
      }
      if (host.executionHostId === LOCAL_EXECUTION_HOST_ID) {
        stops.push(subscribeLocalRuntimeCapabilitiesKnown(load))
        void ensureLocalRuntimeCapabilities().then(load)
      } else if (host.runtimeEnvironmentId) {
        load(host.capabilities)
        stops.push(
          acquire(
            resource({
              environmentId: host.runtimeEnvironmentId,
              pairingRevision: host.pairingRevision ?? undefined,
              runtimeId: host.runtimeId ?? undefined
            }),
            publish,
            true
          )
        )
      }
    }
    return () => {
      disposed = true
      stops.forEach((stop) => stop())
    }
  }, [active, hosts])
  return version
}

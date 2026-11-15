import { useEffect } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { loadHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import {
  ensureLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilitiesKnown
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'

/**
 * Resume in a chat needs this computer's chat agent catalog. Session History loads it when it opens; the
 * palette loads it only while its Sessions section can show, so nothing is probed while the section is off.
 */
export function usePaletteSessionResumeCatalogs(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return
    }
    let disposed = false
    const load = (capabilities: readonly string[] | null): void => {
      if (!disposed) {
        void loadHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, capabilities, null)
      }
    }
    const stop = subscribeLocalRuntimeCapabilitiesKnown(load)
    void ensureLocalRuntimeCapabilities().then(load)
    return () => {
      disposed = true
      stop()
    }
  }, [active])
}

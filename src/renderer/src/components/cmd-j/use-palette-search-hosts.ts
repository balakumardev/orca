import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/structural-value-equality'
import { recomputeOn } from '@/lib/recompute-on'
import { getPaletteSearchHosts, type PaletteSearchHost } from './palette-search-hosts'

/** Status heartbeats do not restart searches; only source identity, labels, or capabilities change. */
export function usePaletteSearchHosts(hostIds?: readonly string[]): readonly PaletteSearchHost[] {
  const hostSelection = JSON.stringify([...new Set(hostIds ?? [])].sort())
  const localCapabilities = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  // Local capability observations live outside AppState and must invalidate its cached selector.
  const select = useMemo(
    () =>
      recomputeOn([localCapabilities], () => {
        const selectedIds: string[] = JSON.parse(hostSelection)
        let previous: readonly PaletteSearchHost[] = []
        return (state: AppState) => {
          const hosts = getPaletteSearchHosts(state, selectedIds)
          if (!structuralValuesEqualIgnoringUndefined(previous, hosts)) {
            previous = hosts
          }
          return previous
        }
      }),
    [hostSelection, localCapabilities]
  )
  return useAppStore(select)
}

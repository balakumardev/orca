import { useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useActivityDescriptionVisible } from './activity-description-visibility'

/** Row heights differ between densities and with the description shown; drop stale measurements on toggle (not on mount). */
export function useActivityListRemeasure(
  virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, 'measure'>,
  compactMode: boolean
): void {
  const showDescription = useActivityDescriptionVisible()
  const measuredRef = useRef({ compactMode, showDescription })
  useEffect(() => {
    const measured = measuredRef.current
    if (measured.compactMode === compactMode && measured.showDescription === showDescription) {
      return
    }
    measuredRef.current = { compactMode, showDescription }
    virtualizer.measure()
  }, [virtualizer, compactMode, showDescription])
}

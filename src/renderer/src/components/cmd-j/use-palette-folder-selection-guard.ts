import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { keepFolderOffAutoSelection } from './palette-folder-selection'

const MOVE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'])
// cmdk also moves on Ctrl+N, Ctrl+P, Ctrl+J and Ctrl+K.
const CTRL_MOVE_KEYS = new Set(['n', 'p', 'j', 'k'])

function isMoveKey(event: KeyboardEvent): boolean {
  return MOVE_KEYS.has(event.key) || (event.ctrlKey && CTRL_MOVE_KEYS.has(event.key.toLowerCase()))
}

/**
 * Remembers whether the user moved the highlight (a move key, or a pointer press in the list) since the
 * query last changed. The palette's own "moved by user" flag is cleared only when the palette opens, so it
 * cannot tell a move for this query from a move for an earlier one.
 */
export function usePaletteFolderSelectionGuard({
  visible,
  listRef
}: {
  visible: boolean
  listRef: RefObject<Element | null>
}): {
  /** Call on every query change. */
  markQueryChanged: () => void
  /** What to select when cmdk reports `nextItemId`; keeps a folder off cmdk's own first-row pick. */
  guardCommandSelection: (nextItemId: string, selectableItemIds: readonly string[]) => string
} {
  const movedSinceQueryChange = useRef(false)
  useEffect(() => {
    if (!visible) {
      return
    }
    movedSinceQueryChange.current = false
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isMoveKey(event)) {
        movedSinceQueryChange.current = true
      }
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) {
        movedSinceQueryChange.current = true
      }
    }
    // Capture phase, so the flag is set before cmdk reacts to the same event.
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [visible, listRef])
  const markQueryChanged = useCallback((): void => {
    movedSinceQueryChange.current = false
  }, [])
  const guardCommandSelection = useCallback(
    (nextItemId: string, selectableItemIds: readonly string[]): string =>
      keepFolderOffAutoSelection({
        nextItemId,
        selectableItemIds,
        movedSinceQueryChange: movedSinceQueryChange.current
      }),
    []
  )
  return useMemo(
    () => ({ markQueryChanged, guardCommandSelection }),
    [markQueryChanged, guardCommandSelection]
  )
}

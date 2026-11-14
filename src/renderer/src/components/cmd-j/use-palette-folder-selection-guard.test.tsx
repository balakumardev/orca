// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { CREATE_WORKTREE_ITEM_ID } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { FOLDER_SOURCE_ID } from './palette-folder-selection'
import { usePaletteFolderSelectionGuard } from './use-palette-folder-selection-guard'

const folder = encodePaletteIdentity(['extra', FOLDER_SOURCE_ID, '/code/a'])
const rows = [folder, CREATE_WORKTREE_ITEM_ID]

function setup(visible = true) {
  const listRef = createRef<HTMLDivElement>()
  return renderHook(
    (props: { visible: boolean }) =>
      usePaletteFolderSelectionGuard({ visible: props.visible, listRef }),
    { initialProps: { visible } }
  )
}

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, ...init, bubbles: true }))
  })
}

describe('usePaletteFolderSelectionGuard', () => {
  it('keeps a first-row folder off cmdk pick until a move key is pressed', () => {
    const { result } = setup()
    expect(result.current.guardCommandSelection(folder, rows)).toBe(CREATE_WORKTREE_ITEM_ID)
    press('ArrowUp')
    expect(result.current.guardCommandSelection(folder, rows)).toBe(folder)
  })

  it.each([['Home'], ['End'], ['PageUp'], ['PageDown'], ['ArrowDown']])(
    'counts %s as a move',
    (key) => {
      const { result } = setup()
      press(key)
      expect(result.current.guardCommandSelection(folder, rows)).toBe(folder)
    }
  )

  it('counts the cmdk control-key moves, and ignores a plain letter', () => {
    const { result } = setup()
    press('n')
    expect(result.current.guardCommandSelection(folder, rows)).toBe(CREATE_WORKTREE_ITEM_ID)
    press('n', { ctrlKey: true })
    expect(result.current.guardCommandSelection(folder, rows)).toBe(folder)
  })

  it('forgets a move when the query changes', () => {
    const { result } = setup()
    press('ArrowDown')
    act(() => result.current.markQueryChanged())
    expect(result.current.guardCommandSelection(folder, rows)).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('forgets a move when the palette is opened again, and listens only while it is open', () => {
    const { result, rerender } = setup()
    press('ArrowDown')
    rerender({ visible: false })
    press('ArrowDown')
    rerender({ visible: true })
    expect(result.current.guardCommandSelection(folder, rows)).toBe(CREATE_WORKTREE_ITEM_ID)
    rerender({ visible: false })
    press('ArrowDown')
    expect(result.current.guardCommandSelection(folder, rows)).toBe(CREATE_WORKTREE_ITEM_ID)
  })
})

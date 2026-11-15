import { describe, expect, it } from 'vitest'
import { CREATE_WORKTREE_ITEM_ID } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import {
  FOLDER_SOURCE_ID,
  getNextPaletteSelectionWithoutFolderDefault,
  isUnarmedByDefaultPaletteItemId,
  keepFolderOffAutoSelection
} from './palette-folder-selection'
import { SESSION_SOURCE_ID } from './palette-session-source-id'

const session = encodePaletteIdentity(['extra', SESSION_SOURCE_ID, '["claude","s-1",""]'])
const folder = encodePaletteIdentity(['extra', FOLDER_SOURCE_ID, '/code/notes'])
const otherExtra = encodePaletteIdentity(['extra', 'websites', '/code/notes'])
const workspace = 'worktree:alpha'
const base = {
  currentSelectedItemId: '',
  queryChanged: true,
  showCreateAction: true
}

describe('a Sessions row is guarded like a folder row', () => {
  it('is recognised by its source, and other extras are not', () => {
    expect(isUnarmedByDefaultPaletteItemId(session)).toBe(true)
    expect(isUnarmedByDefaultPaletteItemId(otherExtra)).toBe(false)
  })

  it('is never the row a fresh query arms', () => {
    expect(
      getNextPaletteSelectionWithoutFolderDefault({
        ...base,
        selectableItemIds: [session, workspace]
      })
    ).toBe(workspace)
    // Nothing is armed rather than a transcript, which is what the palette armed before this section existed.
    expect(
      getNextPaletteSelectionWithoutFolderDefault({ ...base, selectableItemIds: [session] })
    ).toBe('')
    expect(
      getNextPaletteSelectionWithoutFolderDefault({
        ...base,
        selectableItemIds: [session, CREATE_WORKTREE_ITEM_ID]
      })
    ).toBe('')
  })

  it('stays armed only when the user moved to it for the current query', () => {
    const moved = {
      ...base,
      queryChanged: false,
      currentSelectedItemId: session,
      selectableItemIds: [workspace, session]
    }
    expect(getNextPaletteSelectionWithoutFolderDefault(moved)).toBe(session)
    expect(getNextPaletteSelectionWithoutFolderDefault({ ...moved, queryChanged: true })).toBe(
      workspace
    )
  })

  it('is kept off the first-row pick cmdk makes by itself, and not off a later row', () => {
    expect(
      keepFolderOffAutoSelection({
        nextItemId: session,
        selectableItemIds: [session, folder, CREATE_WORKTREE_ITEM_ID],
        movedSinceQueryChange: false
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
    expect(
      keepFolderOffAutoSelection({
        nextItemId: session,
        selectableItemIds: [workspace, session],
        movedSinceQueryChange: false
      })
    ).toBe(session)
    expect(
      keepFolderOffAutoSelection({
        nextItemId: session,
        selectableItemIds: [session, CREATE_WORKTREE_ITEM_ID],
        movedSinceQueryChange: true
      })
    ).toBe(session)
  })
})

import { describe, expect, it } from 'vitest'
import {
  CREATE_WORKTREE_ITEM_ID,
  getNextWorktreePaletteSelection
} from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { PROJECT_CREATE_SOURCE_ID } from './palette-project-create-source-id'
import { SESSION_SOURCE_ID } from './palette-session-source-id'
import {
  FOLDER_SOURCE_ID,
  getNextPaletteSelectionWithoutFolderDefault,
  isUnarmedByDefaultPaletteItemId,
  keepFolderOffAutoSelection
} from './palette-folder-selection'

const folder = encodePaletteIdentity(['extra', FOLDER_SOURCE_ID, '/code/notes'])
const otherExtra = encodePaletteIdentity(['extra', 'websites', '/code/notes'])
const projectCreate = encodePaletteIdentity(['extra', PROJECT_CREATE_SOURCE_ID, 'repo-acme-web'])
const session = encodePaletteIdentity(['extra', SESSION_SOURCE_ID, 'claude:abc'])
const action = 'quick-action:new-terminal-tab'

const base = {
  currentSelectedItemId: '',
  queryChanged: true,
  showCreateAction: true
}

describe('isUnarmedByDefaultPaletteItemId', () => {
  it('recognises a folder row, a new-worktree row and a session row, and nothing else', () => {
    expect(isUnarmedByDefaultPaletteItemId(folder)).toBe(true)
    expect(isUnarmedByDefaultPaletteItemId(projectCreate)).toBe(true)
    expect(isUnarmedByDefaultPaletteItemId(session)).toBe(true)
    expect(isUnarmedByDefaultPaletteItemId(otherExtra)).toBe(false)
    expect(isUnarmedByDefaultPaletteItemId(action)).toBe(false)
  })
})

describe('getNextPaletteSelectionWithoutFolderDefault', () => {
  it('arms the first row that is not a folder', () => {
    expect(
      getNextPaletteSelectionWithoutFolderDefault({ ...base, selectableItemIds: [folder, action] })
    ).toBe(action)
  })

  it('arms nothing when only folders match', () => {
    expect(
      getNextPaletteSelectionWithoutFolderDefault({ ...base, selectableItemIds: [folder] })
    ).toBe('')
  })

  it('still lands on Create when a task link asks for it', () => {
    expect(
      getNextPaletteSelectionWithoutFolderDefault({
        ...base,
        selectableItemIds: [folder, CREATE_WORKTREE_ITEM_ID],
        autoSelectCreateAction: true
      })
    ).toBe(CREATE_WORKTREE_ITEM_ID)
  })

  it('keeps a folder the user moved to', () => {
    expect(
      getNextPaletteSelectionWithoutFolderDefault({
        ...base,
        queryChanged: false,
        currentSelectedItemId: folder,
        selectableItemIds: [folder, action]
      })
    ).toBe(folder)
  })

  it('does not keep a folder from the previous query', () => {
    expect(
      getNextPaletteSelectionWithoutFolderDefault({
        ...base,
        currentSelectedItemId: folder,
        selectableItemIds: [folder, action]
      })
    ).toBe(action)
  })

  it('answers exactly what the upstream function answers when no folder is listed', () => {
    const args = { ...base, selectableItemIds: [action, otherExtra] }
    expect(getNextPaletteSelectionWithoutFolderDefault(args)).toBe(
      getNextWorktreePaletteSelection(args)
    )
  })
})

describe('keepFolderOffAutoSelection', () => {
  const create = CREATE_WORKTREE_ITEM_ID

  it('sends cmdk first-row pick to the next row that is not a folder', () => {
    expect(
      keepFolderOffAutoSelection({
        nextItemId: folder,
        selectableItemIds: [folder, create],
        movedSinceQueryChange: false
      })
    ).toBe(create)
  })

  it('leaves a folder the user moved to since the query changed, or hovered further down the list', () => {
    const second = encodePaletteIdentity(['extra', FOLDER_SOURCE_ID, '/code/second'])
    expect(
      keepFolderOffAutoSelection({
        nextItemId: folder,
        selectableItemIds: [folder, create],
        movedSinceQueryChange: true
      })
    ).toBe(folder)
    expect(
      keepFolderOffAutoSelection({
        nextItemId: second,
        selectableItemIds: [action, second],
        movedSinceQueryChange: false
      })
    ).toBe(second)
  })

  it('passes every other row through', () => {
    expect(
      keepFolderOffAutoSelection({
        nextItemId: action,
        selectableItemIds: [action, folder],
        movedSinceQueryChange: false
      })
    ).toBe(action)
  })

  it('arms nothing when only folders are listed', () => {
    expect(
      keepFolderOffAutoSelection({
        nextItemId: folder,
        selectableItemIds: [folder],
        movedSinceQueryChange: false
      })
    ).toBe('')
  })
})

describe('a "New worktree in <Project>" row is guarded like a folder row', () => {
  const create = CREATE_WORKTREE_ITEM_ID

  it('is never the row a fresh query arms', () => {
    expect(
      getNextPaletteSelectionWithoutFolderDefault({
        ...base,
        selectableItemIds: [projectCreate, folder, action]
      })
    ).toBe(action)
    expect(
      getNextPaletteSelectionWithoutFolderDefault({ ...base, selectableItemIds: [projectCreate] })
    ).toBe('')
  })

  it('stays armed only when the user moved to it for the current query', () => {
    const moved = {
      ...base,
      queryChanged: false,
      currentSelectedItemId: projectCreate,
      selectableItemIds: [action, projectCreate]
    }
    expect(getNextPaletteSelectionWithoutFolderDefault(moved)).toBe(projectCreate)
    expect(getNextPaletteSelectionWithoutFolderDefault({ ...moved, queryChanged: true })).toBe(
      action
    )
  })

  it('is kept off the first-row pick cmdk makes by itself', () => {
    expect(
      keepFolderOffAutoSelection({
        nextItemId: projectCreate,
        selectableItemIds: [projectCreate, create],
        movedSinceQueryChange: false
      })
    ).toBe(create)
    expect(
      keepFolderOffAutoSelection({
        nextItemId: projectCreate,
        selectableItemIds: [projectCreate, create],
        movedSinceQueryChange: true
      })
    ).toBe(projectCreate)
  })
})

// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Command } from 'cmdk'
import { useCallback, useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CREATE_WORKTREE_ITEM_ID } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import {
  FOLDER_SOURCE_ID,
  getNextPaletteSelectionWithoutFolderDefault
} from './palette-folder-selection'
import { usePaletteFolderSelectionGuard } from './use-palette-folder-selection-guard'

const folder = (name: string): string =>
  encodePaletteIdentity(['extra', FOLDER_SOURCE_ID, `/code/${name}`])
const WORKSPACE = 'worktree:alpha'

/** The rows the palette lists for a query, in its real order: workspaces, folders, Create last. */
const ROWS: Record<string, string[]> = {
  f: [WORKSPACE, folder('foo-unique'), CREATE_WORKTREE_ITEM_ID],
  fo: [WORKSPACE, folder('foo-unique'), CREATE_WORKTREE_ITEM_ID],
  foo: [WORKSPACE, folder('foo-unique'), CREATE_WORKTREE_ITEM_ID],
  'foo-': [folder('foo-unique'), CREATE_WORKTREE_ITEM_ID],
  'foo-unique': [folder('foo-unique'), CREATE_WORKTREE_ITEM_ID],
  // A folder first, then a workspace: the user can jump to either end.
  mix: [folder('mix-a'), WORKSPACE, CREATE_WORKTREE_ITEM_ID]
}
const opened: string[] = []

function label(id: string): string {
  if (id === CREATE_WORKTREE_ITEM_ID) {
    return 'create'
  }
  return id === WORKSPACE ? 'workspace' : `folder:${id.slice(id.lastIndexOf('/') + 1)}`
}

/**
 * The palette's selection wiring around the real cmdk: a controlled value, onValueChange, the
 * deferred-query layout effect and the key and pointer capture. Rows are fixed per query.
 */
function Palette(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const guard = usePaletteFolderSelectionGuard({ visible: true, listRef })
  const deferredQuery = useDeferredValue(query)
  const ids = ROWS[deferredQuery] ?? []
  const armedId = getNextPaletteSelectionWithoutFolderDefault({
    currentSelectedItemId: selectedId,
    queryChanged: false,
    selectableItemIds: ids,
    showCreateAction: true
  })
  const handleCommandSelectionChange = useCallback(
    (nextItemId: string) => setSelectedId(guard.guardCommandSelection(nextItemId, ids)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- ids only changes with the query.
    [guard, ids.join('|')]
  )
  useLayoutEffect(() => {
    setSelectedId(
      getNextPaletteSelectionWithoutFolderDefault({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: ids,
        showCreateAction: true
      })
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- selection resets when the deferred query commits.
  }, [deferredQuery])
  return (
    <Command shouldFilter={false} loop value={armedId} onValueChange={handleCommandSelectionChange}>
      <Command.Input
        value={query}
        onValueChange={(next) => {
          guard.markQueryChanged()
          setQuery(next)
          setSelectedId('')
        }}
      />
      <Command.List ref={listRef}>
        {ids.map((id) => (
          <Command.Item
            key={id}
            value={id}
            data-row={label(id)}
            onSelect={() => opened.push(label(id))}
          >
            {label(id)}
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  )
}

const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
const input = (): Element => {
  const element = document.querySelector('[cmdk-input]')
  if (!element) {
    throw new Error('no input')
  }
  return element
}
async function type(query: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input(), { target: { value: query } })
  })
  await settle()
}
async function press(key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(input(), { key })
  })
  await settle()
}
const selectedRow = (): string | undefined =>
  document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute('data-row') ?? undefined

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})
afterEach(() => {
  cleanup()
  opened.length = 0
})

describe('Enter with a folder among the rows, wired to the real cmdk', () => {
  it('does what it did before: a fresh query that matches a folder and Create arms Create', async () => {
    render(<Palette />)
    await settle()
    await type('fo')
    await type('foo-unique')
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('arms Create after an arrow key moved the highlight for an earlier query', async () => {
    render(<Palette />)
    await settle()
    await type('fo')
    await press('ArrowDown')
    expect(selectedRow()).toBe('folder:foo-unique')
    await type('foo-unique')
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('arms Create after a keystroke-by-keystroke edit that follows an arrow key', async () => {
    render(<Palette />)
    await settle()
    await type('f')
    await type('fo')
    await press('ArrowDown')
    await type('foo')
    await type('foo-')
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('arms Create after a pointer press in the list for an earlier query', async () => {
    render(<Palette />)
    await settle()
    await type('fo')
    const list = document.querySelector('[cmdk-list]')
    if (!list) {
      throw new Error('no list')
    }
    await act(async () => {
      fireEvent.pointerDown(list)
    })
    await type('foo-unique')
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('keeps a folder the user arrowed to for the current query, and Enter opens it', async () => {
    render(<Palette />)
    await settle()
    await type('foo-unique')
    expect(selectedRow()).toBe('create')
    await press('ArrowUp')
    expect(selectedRow()).toBe('folder:foo-unique')
    await press('Enter')
    expect(opened).toEqual(['folder:foo-unique'])
  })

  it('lets Home reach a first-row folder once the user moved for the current query', async () => {
    render(<Palette />)
    await settle()
    await type('mix')
    expect(selectedRow()).toBe('workspace')
    await press('End')
    expect(selectedRow()).toBe('create')
    await press('Home')
    expect(selectedRow()).toBe('folder:mix-a')
  })

  it('lets a pointer press for the current query make a hovered first-row folder the selection', async () => {
    render(<Palette />)
    await settle()
    await type('mix')
    const list = document.querySelector('[cmdk-list]')
    const createRow = document.querySelector('[data-row="create"]')
    const folderRow = document.querySelector('[data-row="folder:mix-a"]')
    if (!list || !createRow || !folderRow) {
      throw new Error('no rows')
    }
    await act(async () => {
      fireEvent.pointerMove(createRow)
    })
    await settle()
    expect(selectedRow()).toBe('create')
    await act(async () => {
      fireEvent.pointerDown(list)
    })
    await act(async () => {
      fireEvent.pointerMove(folderRow)
    })
    await settle()
    expect(selectedRow()).toBe('folder:mix-a')
  })

  it('lets the user arrow to a first-row folder again after editing the query', async () => {
    render(<Palette />)
    await settle()
    await type('fo')
    await press('ArrowDown')
    await type('foo-unique')
    await press('ArrowUp')
    expect(selectedRow()).toBe('folder:foo-unique')
    await press('Enter')
    expect(opened).toEqual(['folder:foo-unique'])
  })
})

// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Command } from 'cmdk'
import { useCallback, useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CREATE_WORKTREE_ITEM_ID,
  getWorktreePaletteSelectionItemIds
} from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { getNextPaletteSelectionWithoutFolderDefault } from './palette-folder-selection'
import { SESSION_SOURCE_ID } from './palette-session-source-id'
import { usePaletteFolderSelectionGuard } from './use-palette-folder-selection-guard'

const session = (name: string): string => encodePaletteIdentity(['extra', SESSION_SOURCE_ID, name])
const SESSION = session('known')
const SESSION_INERT = session('unknown-folder')
const WORKSPACE = 'worktree:alpha'

type Row = { id: string; inert?: boolean }
const create: Row = { id: CREATE_WORKTREE_ITEM_ID }
const workspace: Row = { id: WORKSPACE }

/** The rows the palette lists once the search answered: workspaces first, then the sessions, Create last. */
const WITH_SESSION: Record<string, Row[]> = {
  bil: [{ id: SESSION }, create],
  billing: [{ id: SESSION }, create],
  mix: [workspace, { id: SESSION }, create],
  // The first session is inert (its folder is not in Orca); a later one is armed. cmdk skips the disabled row.
  quarterly: [{ id: SESSION_INERT, inert: true }, { id: SESSION }, create],
  quarter: [{ id: SESSION_INERT, inert: true }, { id: SESSION }, create]
}
const WITHOUT_SESSION: Record<string, Row[]> = {
  bil: [create],
  billing: [create],
  mix: [workspace, create],
  quarterly: [create],
  quarter: [create]
}
const opened: string[] = []
let landSessions: () => void = () => {}

function label(id: string): string {
  if (id === CREATE_WORKTREE_ITEM_ID) {
    return 'create'
  }
  if (id === WORKSPACE) {
    return 'workspace'
  }
  return id === SESSION_INERT ? 'session-inert' : 'session'
}

/**
 * The palette's selection wiring around the real cmdk: a controlled value, onValueChange, the
 * deferred-query layout effect and the key and pointer capture. The sessions land after the query, as the
 * debounced search does. The selectable ids come from the palette's own function, so an inert row is
 * handled exactly as it is in the palette.
 */
function Palette(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [landed, setLanded] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const guard = usePaletteFolderSelectionGuard({ visible: true, listRef })
  const deferredQuery = useDeferredValue(query)
  landSessions = () => setLanded(true)
  const rows = (landed ? WITH_SESSION : WITHOUT_SESSION)[deferredQuery] ?? []
  const ids = getWorktreePaletteSelectionItemIds(
    rows.map((row) => ({
      id: row.id,
      type: row.id === CREATE_WORKTREE_ITEM_ID ? 'create-worktree' : 'extra',
      result: { inert: row.inert }
    }))
  )
  const armedId = getNextPaletteSelectionWithoutFolderDefault({
    currentSelectedItemId: selectedId,
    queryChanged: false,
    selectableItemIds: ids,
    showCreateAction: true
  })
  const handleCommandSelectionChange = useCallback(
    (nextItemId: string) => setSelectedId(guard.guardCommandSelection(nextItemId, ids)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- ids only changes with the query and the landing.
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
          setLanded(false)
          setSelectedId('')
        }}
      />
      <Command.List ref={listRef}>
        {rows.map((row) => (
          <Command.Item
            key={row.id}
            value={row.id}
            disabled={row.inert}
            data-row={label(row.id)}
            onSelect={() => opened.push(label(row.id))}
          >
            {label(row.id)}
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  )
}

const settle = (): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(30)
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
async function land(): Promise<void> {
  await act(async () => landSessions())
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
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  opened.length = 0
})

describe('Enter with a Sessions row among the rows, wired to the real cmdk', () => {
  it('arms Create when the sessions landed and are the first rows', async () => {
    render(<Palette />)
    await settle()
    await type('billing')
    await land()
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('arms Create when a key moved the highlight before the sessions landed', async () => {
    render(<Palette />)
    await settle()
    await type('bil')
    await press('ArrowDown')
    await land()
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('arms Create after an arrow key moved the highlight for an earlier query', async () => {
    render(<Palette />)
    await settle()
    await type('mix')
    await land()
    await press('ArrowDown')
    expect(selectedRow()).toBe('session')
    await type('billing')
    await land()
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('arms Create when the first session is inert and a later one is armed', async () => {
    render(<Palette />)
    await settle()
    await type('quarterly')
    await land()
    // cmdk skips the disabled first row and picks the armed session; the guard must still send it to Create.
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('arms Create for a replaced query whose first session is inert, after a move for the earlier query', async () => {
    render(<Palette />)
    await settle()
    await type('mix')
    await land()
    await press('ArrowDown')
    expect(selectedRow()).toBe('session')
    await type('quarterly')
    await land()
    expect(selectedRow()).toBe('create')
    await type('quarter')
    await land()
    expect(selectedRow()).toBe('create')
    await press('Enter')
    expect(opened).toEqual(['create'])
  })

  it('opens the armed session the user arrowed to, past the inert one', async () => {
    render(<Palette />)
    await settle()
    await type('quarterly')
    await land()
    await press('ArrowUp')
    expect(selectedRow()).toBe('session')
    await press('Enter')
    expect(opened).toEqual(['session'])
  })

  it('opens a session the user arrowed to after it landed', async () => {
    render(<Palette />)
    await settle()
    await type('mix')
    await land()
    expect(selectedRow()).toBe('workspace')
    await press('ArrowDown')
    expect(selectedRow()).toBe('session')
    await press('Enter')
    expect(opened).toEqual(['session'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { buildSessionPaletteResults } from './palette-session-results'
import { sessionHit } from './palette-session-hit.test-fixture'

const actions = {
  untitled: 'Untitled session',
  onOpen: vi.fn(),
  isInert: () => false,
  decorate: () => ({})
}

describe('buildSessionPaletteResults', () => {
  it('keeps the index order and hands the palette no rank and no quality', () => {
    const rows = buildSessionPaletteResults(
      [sessionHit('s-b'), sessionHit('s-a'), sessionHit('s-c')],
      'billing',
      actions
    )
    expect(rows.map((row) => row.title)).toEqual(['Title of s-b', 'Title of s-a', 'Title of s-c'])
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2])
    expect(rows.every((row) => row.rank === null && row.qualityClass === null)).toBe(true)
  })

  it('shows the best 5 hits only', () => {
    const hits = ['1', '2', '3', '4', '5', '6', '7', '8'].map((id) => sessionHit(`s-${id}`))
    const rows = buildSessionPaletteResults(hits, 'billing', actions)
    expect(rows.map((row) => row.title)).toEqual([
      'Title of s-1',
      'Title of s-2',
      'Title of s-3',
      'Title of s-4',
      'Title of s-5'
    ])
  })

  it('lists a conversation once, and tells two agents with one id apart', () => {
    const rows = buildSessionPaletteResults(
      [sessionHit('s-1'), sessionHit('s-1'), sessionHit('s-1', { agent: 'codex' })],
      'billing',
      actions
    )
    expect(rows).toHaveLength(2)
  })

  it('falls back to the given title when the transcript has none', () => {
    const rows = buildSessionPaletteResults(
      [sessionHit('s-1', { title: '  ' })],
      'billing',
      actions
    )
    expect(rows[0].title).toBe('Untitled session')
  })

  it('reads the last activity from the transcript timestamp', () => {
    const rows = buildSessionPaletteResults(
      [
        sessionHit('s-1'),
        sessionHit('s-2', { updatedAt: null }),
        sessionHit('s-3', { updatedAt: 'x' })
      ],
      'billing',
      actions
    )
    expect(rows.map((row) => row.lastActiveAt)).toEqual([1794297600000, null, null])
  })

  it('marks the words of the query inside the title', () => {
    const rows = buildSessionPaletteResults(
      [sessionHit('s-1', { title: 'Refactor billing exporter' })],
      'billing',
      actions
    )
    expect(rows[0].titleRanges).toEqual([{ start: 9, end: 16 }])
  })

  it('marks a row inert from the callback and calls onOpen with its own hit when chosen', () => {
    const onOpen = vi.fn()
    const first = sessionHit('s-1')
    const second = sessionHit('s-2')
    const rows = buildSessionPaletteResults([first, second], 'billing', {
      ...actions,
      onOpen,
      isInert: (hit) => hit.sessionId === 's-2'
    })
    expect(rows.map((row) => row.inert)).toEqual([false, true])
    rows[1].onSelect()
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(second)
  })
})

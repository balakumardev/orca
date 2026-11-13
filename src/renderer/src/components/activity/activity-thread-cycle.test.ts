import { describe, expect, it } from 'vitest'
import { cycleActivityThread } from './activity-thread-cycle'

const rows = [{ paneKey: 'a' }, { paneKey: 'b' }, { paneKey: 'c' }]

describe('cycleActivityThread', () => {
  it('moves to the following and the preceding row', () => {
    expect(cycleActivityThread(rows, 'a', 'next')).toBe(rows[1])
    expect(cycleActivityThread(rows, 'c', 'previous')).toBe(rows[1])
  })

  it('wraps at both ends', () => {
    expect(cycleActivityThread(rows, 'c', 'next')).toBe(rows[0])
    expect(cycleActivityThread(rows, 'a', 'previous')).toBe(rows[2])
  })

  it('starts at the first row for next and the last row for previous without a selection', () => {
    expect(cycleActivityThread(rows, null, 'next')).toBe(rows[0])
    expect(cycleActivityThread(rows, null, 'previous')).toBe(rows[2])
  })

  it('treats a selection missing from the list like no selection', () => {
    expect(cycleActivityThread(rows, 'gone', 'next')).toBe(rows[0])
    expect(cycleActivityThread(rows, 'gone', 'previous')).toBe(rows[2])
  })

  it('selects the only row in either direction', () => {
    const only = [{ paneKey: 'solo' }]
    expect(cycleActivityThread(only, 'solo', 'next')).toBe(only[0])
    expect(cycleActivityThread(only, 'solo', 'previous')).toBe(only[0])
    expect(cycleActivityThread(only, null, 'next')).toBe(only[0])
  })

  it('does nothing for an empty list', () => {
    expect(cycleActivityThread([], null, 'next')).toBeNull()
    expect(cycleActivityThread([], 'a', 'previous')).toBeNull()
  })
})

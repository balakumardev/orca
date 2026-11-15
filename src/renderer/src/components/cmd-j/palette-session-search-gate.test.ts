import { describe, expect, it } from 'vitest'
import { isSessionIndexReady, sessionSearchQuery } from './palette-session-search-gate'

describe('sessionSearchQuery', () => {
  it('waits for a second character and trims the query', () => {
    expect(sessionSearchQuery('')).toBeNull()
    expect(sessionSearchQuery('b')).toBeNull()
    expect(sessionSearchQuery('  b  ')).toBeNull()
    expect(sessionSearchQuery('bi')).toBe('bi')
    expect(sessionSearchQuery('  billing exporter ')).toBe('billing exporter')
  })

  it('skips pasted text that is too large for the palette, which then shows no Create row', () => {
    expect(sessionSearchQuery('a'.repeat(2048))).toBe('a'.repeat(2048))
    expect(sessionSearchQuery('a'.repeat(2049))).toBeNull()
  })

  it('counts characters, not UTF-16 units', () => {
    expect(sessionSearchQuery('😀')).toBeNull()
    expect(sessionSearchQuery('日本')).toBe('日本')
  })
})

describe('isSessionIndexReady', () => {
  const sweep = { lastSweepCompletedAt: 1794297600000 }

  it('is false while search is off', () => {
    expect(isSessionIndexReady({ enabled: false, phase: 'idle', lastSweepCompletedAt: null })).toBe(
      false
    )
    expect(isSessionIndexReady({ enabled: false, phase: 'current', ...sweep })).toBe(false)
  })

  it('is false until the first full pass has finished', () => {
    expect(
      isSessionIndexReady({ enabled: true, phase: 'indexing', lastSweepCompletedAt: null })
    ).toBe(false)
    expect(
      isSessionIndexReady({ enabled: true, phase: 'degraded', lastSweepCompletedAt: null })
    ).toBe(false)
  })

  it('stays true while an agent writes a transcript and the phase reads indexing', () => {
    expect(isSessionIndexReady({ enabled: true, phase: 'indexing', ...sweep })).toBe(true)
    expect(isSessionIndexReady({ enabled: true, phase: 'current', ...sweep })).toBe(true)
    expect(isSessionIndexReady({ enabled: true, phase: 'degraded', ...sweep })).toBe(true)
  })

  it('is false once the index is closed', () => {
    expect(isSessionIndexReady({ enabled: true, phase: 'closed', ...sweep })).toBe(false)
  })
})

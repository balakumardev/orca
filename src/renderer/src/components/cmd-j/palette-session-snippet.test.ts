import { describe, expect, it } from 'vitest'
import { paletteSessionSnippetAddsInfo } from './palette-session-snippet'

describe('paletteSessionSnippetAddsInfo', () => {
  it('is false when the excerpt is the title text with the match marked', () => {
    expect(
      paletteSessionSnippetAddsInfo('refactor [[billing]] exporter', 'refactor billing exporter')
    ).toBe(false)
  })

  it('is false when the excerpt is a window of a longer title, with ellipses and other case', () => {
    expect(
      paletteSessionSnippetAddsInfo(
        '…rounding for the [[billing]] export…',
        'Fix the Rounding for the Billing export when a line item has no tax'
      )
    ).toBe(false)
  })

  it('is false for an empty excerpt', () => {
    expect(paletteSessionSnippetAddsInfo('  ', 'refactor billing exporter')).toBe(false)
  })

  it('is true when the excerpt comes from a different message', () => {
    expect(
      paletteSessionSnippetAddsInfo(
        'The [[quarterly]] rounding now happens per line item.',
        'refactor billing exporter'
      )
    ).toBe(true)
  })
})

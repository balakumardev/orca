// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionHit } from './palette-session-hit.test-fixture'
import { PaletteSessionLine } from './palette-session-row-parts'

afterEach(cleanup)

const where = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('[data-palette-session-where]')
  if (!element) {
    throw new Error('no where line')
  }
  return element
}

describe('PaletteSessionLine', () => {
  it('names the reason a row is inert on its first line', () => {
    const { container, rerender } = render(
      <PaletteSessionLine hit={sessionHit('s-1')} title="Title" inertReason="folder-not-in-orca" />
    )
    expect(where(container).getAttribute('data-palette-session-inert')).toBe('folder-not-in-orca')
    rerender(
      <PaletteSessionLine hit={sessionHit('s-1')} title="Title" inertReason="cannot-resume" />
    )
    expect(where(container).getAttribute('data-palette-session-inert')).toBe('cannot-resume')
  })

  it('carries no inert reason on a row that can be opened', () => {
    const { container } = render(
      <PaletteSessionLine hit={sessionHit('s-1')} title="Title" inertReason={null} />
    )
    expect(where(container).hasAttribute('data-palette-session-inert')).toBe(false)
  })

  it('puts the hint ahead of the folder name, which a long name would push out of view', () => {
    const { container } = render(
      <PaletteSessionLine
        hit={sessionHit('s-1', { cwd: '/code/a-very-long-folder-name', branch: 'main' })}
        title="Title"
        inertReason="folder-not-in-orca"
      />
    )
    const text = where(container).textContent ?? ''
    expect(text.indexOf('a-very-long-folder-name')).toBeGreaterThan(-1)
    expect(text.indexOf('Claude')).toBeLessThan(text.indexOf('a-very-long-folder-name'))
    expect(text.indexOf(' · ', text.indexOf('Claude'))).toBeLessThan(
      text.indexOf('a-very-long-folder-name')
    )
    expect(text.split(' · ')).toHaveLength(4)
    expect(text.split(' · ')[2]).toBe('a-very-long-folder-name')
  })

  it('shows the excerpt with the matched word marked, only when it adds to the title', () => {
    const different = render(
      <PaletteSessionLine
        hit={sessionHit('s-1', {
          evidence: { role: 'assistant', timestamp: null, snippet: 'ship the [[billing]] exporter' }
        })}
        title="Refactor the ledger"
        inertReason={null}
      />
    )
    expect(
      different.container.querySelector('[data-palette-session-snippet] mark')?.textContent
    ).toBe('billing')
    cleanup()
    const same = render(
      <PaletteSessionLine
        hit={sessionHit('s-1', {
          evidence: { role: 'user', timestamp: null, snippet: 'refactor [[billing]] exporter' }
        })}
        title="refactor billing exporter"
        inertReason={null}
      />
    )
    expect(same.container.querySelector('[data-palette-session-snippet]')).toBeNull()
  })
})

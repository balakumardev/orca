import { describe, expect, it } from 'vitest'
import { getWorktreePaletteSelectionItemIds } from './worktree-palette-create-action'

const entries = [
  { id: 'header', type: 'section-header' },
  { id: 'workspace', type: 'worktree' },
  { id: 'inert-first', type: 'extra', result: { inert: true } },
  { id: 'armed', type: 'extra', result: { inert: false } },
  { id: 'plain-extra', type: 'extra', result: {} },
  { id: 'project', type: 'project-target', result: { name: 'repo' } },
  { id: 'create', type: 'create-worktree' }
]

describe('getWorktreePaletteSelectionItemIds', () => {
  it('lists the selectable rows in order, skipping headers and any inert row that nothing can select', () => {
    expect(getWorktreePaletteSelectionItemIds(entries)).toEqual([
      'workspace',
      'armed',
      'plain-extra',
      'project',
      'create'
    ])
  })

  it('keeps the render key of the rows that remain', () => {
    expect(
      getWorktreePaletteSelectionItemIds(entries, [
        'k-header',
        'k-workspace',
        'k-inert',
        'k-armed',
        'k-plain',
        'k-project',
        'k-create'
      ])
    ).toEqual(['k-workspace', 'k-armed', 'k-plain', 'k-project', 'k-create'])
  })

  it('makes the first armed session the first selectable row when the sessions before it are inert', () => {
    const onlySessions = [
      { id: 'inert-first', type: 'extra', result: { inert: true } },
      { id: 'armed', type: 'extra', result: { inert: false } },
      { id: 'create', type: 'create-worktree' }
    ]
    expect(getWorktreePaletteSelectionItemIds(onlySessions)[0]).toBe('armed')
  })
})

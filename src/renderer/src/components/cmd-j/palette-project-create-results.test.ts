import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { buildProjectCreatePaletteResults } from './palette-project-create-results'
import type { ProjectCreateTarget } from './palette-project-create-targets'

function target(id: string, label: string): ProjectCreateTarget {
  const repo: Repo = {
    id,
    path: `/code/${label}`,
    displayName: label,
    badgeColor: '#000',
    addedAt: 0
  }
  return { repo, label, exact: false }
}

describe('buildProjectCreatePaletteResults', () => {
  it('keeps the best two projects in order, as rows with no rank, no quality and no activity', () => {
    const onCreate = vi.fn()
    const rows = buildProjectCreatePaletteResults(
      [target('r-web', 'acme-web'), target('r-api', 'acme-api'), target('r-docs', 'acme-docs')],
      { title: (label) => `New worktree in ${label}`, onCreate, decorate: () => ({}) }
    )
    expect(rows.map((row) => [row.id, row.title, row.order])).toEqual([
      ['r-web', 'New worktree in acme-web', 0],
      ['r-api', 'New worktree in acme-api', 1]
    ])
    expect(rows.map((row) => [row.rank, row.qualityClass, row.lastActiveAt])).toEqual([
      [null, null, null],
      [null, null, null]
    ])
  })

  it('selecting a row creates in that row project and nothing else', () => {
    const onCreate = vi.fn()
    const rows = buildProjectCreatePaletteResults([target('r-web', 'acme-web')], {
      title: (label) => label,
      onCreate,
      decorate: () => ({})
    })
    expect(onCreate).not.toHaveBeenCalled()
    rows[0].onSelect()
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onCreate.mock.calls[0][0].repo.id).toBe('r-web')
  })
})

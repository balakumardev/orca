import { describe, expect, it, vi } from 'vitest'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { buildFolderPaletteResults, folderParentPath } from './palette-folder-results'

const actions = { onOpen: vi.fn(), decorate: () => ({}) }

function entries(...paths: string[]): FolderSearchEntry[] {
  return paths.map((path) => ({ path, kind: 'folder' }))
}

describe('folderParentPath', () => {
  it('drops the last segment for either separator', () => {
    expect(folderParentPath('/home/dev/code/app')).toBe('/home/dev/code')
    expect(folderParentPath('C:\\dev\\code\\app')).toBe('C:\\dev\\code')
  })
})

describe('buildFolderPaletteResults', () => {
  it('matches on the folder name and ranks a name match above a path-only match', () => {
    const results = buildFolderPaletteResults(
      entries('/home/dev/orca-notes/zzz', '/home/dev/code/orca', '/home/dev/code/unrelated'),
      'orca',
      actions
    )
    expect(results.map((result) => result.id)).toEqual([
      '/home/dev/code/orca',
      '/home/dev/orca-notes/zzz'
    ])
    expect(results[0].title).toBe('orca')
    expect(results[0].titleRanges).toEqual([{ start: 0, end: 4 }])
  })

  it('previews only the best matches up to the limit it is given', () => {
    const many = entries(...Array.from({ length: 20 }, (_, index) => `/code/app-${index}`))
    expect(buildFolderPaletteResults(many, 'app', actions, 3)).toHaveLength(3)
  })

  it('stays out of the palette-wide section ranking, ordering rows by their place after sorting', () => {
    const results = buildFolderPaletteResults(
      entries('/home/dev/orca-notes/zzz', '/home/dev/code/orca'),
      'orca',
      actions
    )
    // A rank or quality would let a folder lead the list or arm Enter ahead of workspaces and actions.
    expect(results.map((result) => [result.rank, result.qualityClass, result.order])).toEqual([
      [null, null, 0],
      [null, null, 1]
    ])
  })

  it('keeps scan order among equal matches, so nearer folders come first', () => {
    const results = buildFolderPaletteResults(
      entries('/code/app-b', '/code/group/app-a'),
      'app',
      actions
    )
    expect(results.map((result) => result.id)).toEqual(['/code/app-b', '/code/group/app-a'])
  })

  it('returns nothing when no folder matches', () => {
    expect(buildFolderPaletteResults(entries('/code/app'), 'zzzz', actions)).toEqual([])
  })

  it('opens the entry the row stands for', () => {
    const onOpen = vi.fn()
    const [result] = buildFolderPaletteResults(entries('/code/app'), 'app', {
      ...actions,
      onOpen
    })
    result.onSelect()
    expect(onOpen).toHaveBeenCalledWith({ path: '/code/app', kind: 'folder' })
  })
})

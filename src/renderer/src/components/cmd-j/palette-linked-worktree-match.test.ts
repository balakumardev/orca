import { describe, expect, it } from 'vitest'
import { makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { pickLinkedWorktree } from './palette-linked-worktree-match'

const wt = (path: string) => makeWorktree(`repo-1::${path}`, path, { path })
const feature = wt('/code/feature')
const main = makeWorktree('repo-1::/code/main', 'main', {
  path: '/code/main',
  isMainWorktree: true
})

describe('pickLinkedWorktree', () => {
  it('picks the worktree at the path, never the main checkout beside it', () => {
    expect(pickLinkedWorktree([main, feature], { path: '/code/feature' })).toBe(feature)
    expect(pickLinkedWorktree([main, feature], { path: '/code/missing' })).toBeNull()
  })

  it('matches the real path when the registered path went through a link', () => {
    expect(
      pickLinkedWorktree([main, feature], { path: '/alias/feature', realPath: '/code/feature' })
    ).toBe(feature)
  })

  it('matches a path that differs only in letter case, when exactly one worktree does', () => {
    const recorded = wt('/Users/me/parent/Mixed-wt')
    expect(
      pickLinkedWorktree([main, recorded], {
        path: '/Users/me/Parent/Mixed-wt',
        realPath: '/Users/me/Parent/Mixed-wt'
      })
    ).toBe(recorded)
  })

  it('prefers the exact path, and gives up when case alone cannot tell worktrees apart', () => {
    const lower = wt('/code/wt')
    const upper = wt('/code/WT')
    expect(pickLinkedWorktree([upper, lower], { path: '/code/wt' })).toBe(lower)
    expect(pickLinkedWorktree([upper, lower], { path: '/code/Wt' })).toBeNull()
  })
})

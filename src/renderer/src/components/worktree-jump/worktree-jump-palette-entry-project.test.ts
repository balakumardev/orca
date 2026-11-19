import { describe, expect, it } from 'vitest'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import type { Repo } from '../../../../shared/repository/repo-types'
import { PROJECT_CREATE_SOURCE_ID } from '../cmd-j/palette-project-create-source-id'
import { getPaletteEntryProjectRepoId } from './worktree-jump-palette-entry-project'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import { makeWorktree } from './worktree-jump-palette-test-fixtures'

const repos: Repo[] = [
  { id: 'r-web', path: '/code/acme-web', displayName: 'acme-web', badgeColor: '#000', addedAt: 0 },
  {
    id: 'r-docs',
    path: '/code/docs',
    displayName: 'docs',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'folder'
  }
]
const workspaces = [
  makeWorktree('wt-1', 'feature auth', { repoId: 'r-web' }),
  makeWorktree('wt-2', 'notes', { repoId: 'r-docs' }),
  makeWorktree('wt-3', 'remote copy', { repoId: 'r-web', hostId: 'ssh:box' })
]
const context = { workspaces, repos }

type FakeRow = { id: string; type: string; [field: string]: unknown }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only the fields these fixtures set.
const asEntry = (row: FakeRow): PaletteListEntry => row as PaletteListEntry

function worktreeEntry(id: string): PaletteListEntry {
  const worktree = workspaces.find((candidate) => candidate.id === id)!
  return asEntry({ id, type: 'worktree', worktree, match: {} })
}

describe('getPaletteEntryProjectRepoId', () => {
  it('reads the project of a workspace row', () => {
    expect(getPaletteEntryProjectRepoId(worktreeEntry('wt-1'), context)).toBe('r-web')
  })

  it('reads the project of a project row but not of a group row', () => {
    const project = asEntry({
      id: 'project:r-web',
      type: 'project-target',
      result: { kind: 'project', repo: repos[0] }
    })
    const group = asEntry({
      id: 'project-group:g',
      type: 'project-target',
      result: { kind: 'project-group' }
    })
    expect(getPaletteEntryProjectRepoId(project, context)).toBe('r-web')
    expect(getPaletteEntryProjectRepoId(group, context)).toBeNull()
  })

  it('reads the project of a workspace tab row through the workspace it sits in', () => {
    const tab = (worktreeId: string, executionHostId?: string): PaletteListEntry =>
      asEntry({ id: 'tab', type: 'workspace-tab', result: { worktreeId, executionHostId } })
    // A local tab may spell its host differently from the workspace row; the id is unique, so it is found.
    expect(getPaletteEntryProjectRepoId(tab('wt-1', 'local'), context)).toBe('r-web')
    expect(getPaletteEntryProjectRepoId(tab('wt-1'), context)).toBe('r-web')
    expect(getPaletteEntryProjectRepoId(tab('wt-3', 'ssh:box'), context)).toBe('r-web')
  })

  it('tells two workspaces with one id apart by host, and answers null when it cannot', () => {
    const twins = [
      makeWorktree('wt-same', 'a', { repoId: 'r-web', hostId: 'ssh:a' }),
      makeWorktree('wt-same', 'b', { repoId: 'r-docs', hostId: 'ssh:b' })
    ]
    const withRepos = [repos[0], { ...repos[1], kind: 'git' as const }]
    const tab = (executionHostId?: string): PaletteListEntry =>
      asEntry({
        id: 'tab',
        type: 'workspace-tab',
        result: { worktreeId: 'wt-same', executionHostId }
      })
    expect(
      getPaletteEntryProjectRepoId(tab('ssh:b'), { workspaces: twins, repos: withRepos })
    ).toBe('r-docs')
    expect(
      getPaletteEntryProjectRepoId(tab('ssh:c'), { workspaces: twins, repos: withRepos })
    ).toBeNull()
  })

  it('reads the project of a new-worktree row from its row id, and no other extra row', () => {
    const extra = (sourceId: string): PaletteListEntry =>
      asEntry({
        id: encodePaletteIdentity(['extra', sourceId, 'r-web']),
        type: 'extra',
        sourceId,
        result: { id: 'r-web' }
      })
    expect(getPaletteEntryProjectRepoId(extra(PROJECT_CREATE_SOURCE_ID), context)).toBe('r-web')
    expect(getPaletteEntryProjectRepoId(extra('folders'), context)).toBeNull()
  })

  it('answers null for a folder project, an unknown project and rows with no project', () => {
    expect(getPaletteEntryProjectRepoId(worktreeEntry('wt-2'), context)).toBeNull()
    expect(
      getPaletteEntryProjectRepoId(worktreeEntry('wt-1'), { workspaces, repos: [repos[1]] })
    ).toBeNull()
    expect(getPaletteEntryProjectRepoId(undefined, context)).toBeNull()
    expect(
      getPaletteEntryProjectRepoId({ id: '__create_worktree__', type: 'create-worktree' }, context)
    ).toBeNull()
    expect(
      getPaletteEntryProjectRepoId(
        asEntry({ id: 'quick-action:x', type: 'quick-action', result: {} }),
        context
      )
    ).toBeNull()
  })
})

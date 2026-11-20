import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  findProjectCreateTargets,
  getProjectCreateLabel,
  resolveProjectScopedCreate,
  type PaletteProjectCatalog
} from './palette-project-create-targets'

function repo(id: string, displayName: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/code/${displayName}`,
    displayName,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function catalog(repos: Repo[]): PaletteProjectCatalog {
  return { repos, projects: [], projectHostSetups: [] }
}

const acme = catalog([
  repo('r-web', 'acme-web'),
  repo('r-api', 'acme-api'),
  repo('r-notes', 'notes'),
  repo('r-docs', 'docs-folder', { kind: 'folder' }),
  repo('r-plumbing', 'acme-vm', { connectionId: 'runtime-ssh-box' })
])

describe('findProjectCreateTargets', () => {
  it('lists the git projects the query names, in the palette project order', () => {
    expect(findProjectCreateTargets('acme', acme).map((t) => t.repo.id)).toEqual(['r-web', 'r-api'])
    expect(findProjectCreateTargets('acme-api', acme).map((t) => t.repo.id)).toEqual(['r-api'])
  })

  it('skips folder projects and projects the composer cannot target', () => {
    expect(findProjectCreateTargets('docs', acme)).toEqual([])
    expect(findProjectCreateTargets('acme-vm', acme)).toEqual([])
  })

  it('does not match a project through the "project" and "repo" aliases', () => {
    expect(findProjectCreateTargets('proj', acme)).toEqual([])
    expect(findProjectCreateTargets('repo', acme)).toEqual([])
  })

  it('flags a query that equals the project title', () => {
    const targets = findProjectCreateTargets('notes', acme)
    expect(targets.map((t) => [t.label, t.exact])).toEqual([['notes', true]])
    expect(findProjectCreateTargets('note', acme).map((t) => t.exact)).toEqual([false])
  })

  it('needs two characters, like the palette project rows', () => {
    expect(findProjectCreateTargets('n', acme)).toEqual([])
  })
})

describe('resolveProjectScopedCreate', () => {
  it('reads <project>/<name> when the project part names one git project', () => {
    expect(resolveProjectScopedCreate('notes/weekly review', acme)).toEqual({
      repoId: 'r-notes',
      projectLabel: 'notes',
      name: 'weekly review',
      workspaceTarget: { projectId: 'repo:r-notes', hostId: 'local' }
    })
    expect(resolveProjectScopedCreate('  acme-web / fix-login ', acme)).toEqual({
      repoId: 'r-web',
      projectLabel: 'acme-web',
      name: 'fix-login',
      workspaceTarget: { projectId: 'repo:r-web', hostId: 'local' }
    })
  })

  it('keeps everything after the first slash in the name', () => {
    expect(resolveProjectScopedCreate('notes/team/standup', acme)?.name).toBe('team/standup')
  })

  it('is null when the project part is no project title, or two projects share it', () => {
    expect(resolveProjectScopedCreate('zebra/x', acme)).toBeNull()
    expect(resolveProjectScopedCreate('acme/x', acme)).toBeNull()
  })

  it('never scopes on a prefix or a part of a title, so branch-style names stay plain', () => {
    const names = catalog([
      repo('r-a', 'fixture-app'),
      repo('r-b', 'feature-flags'),
      repo('r-c', 'acme-web')
    ])
    expect(resolveProjectScopedCreate('fix/login', names)).toBeNull()
    expect(resolveProjectScopedCreate('feat/login', names)).toBeNull()
    expect(resolveProjectScopedCreate('web/foo', names)).toBeNull()
    expect(resolveProjectScopedCreate('acme-w/foo', names)).toBeNull()
  })

  it('scopes on the whole title whatever its case', () => {
    expect(resolveProjectScopedCreate('NOTES/x', acme)).toEqual({
      repoId: 'r-notes',
      projectLabel: 'notes',
      name: 'x',
      workspaceTarget: { projectId: 'repo:r-notes', hostId: 'local' }
    })
  })

  it('stays plain when a longer name starts with the token, and when two projects share a title', () => {
    const withSibling = catalog([repo('r-a', 'notes'), repo('r-b', 'notes-archive')])
    expect(resolveProjectScopedCreate('notes/x', withSibling)?.repoId).toBe('r-a')
    const twins = catalog([repo('r-a', 'notes'), repo('r-b', 'notes', { path: '/other/notes' })])
    expect(resolveProjectScopedCreate('notes/x', twins)).toBeNull()
  })

  it('is null without a project part, without a name, or for a link', () => {
    expect(resolveProjectScopedCreate('/x', acme)).toBeNull()
    expect(resolveProjectScopedCreate('notes/', acme)).toBeNull()
    expect(resolveProjectScopedCreate('notes/   ', acme)).toBeNull()
    expect(resolveProjectScopedCreate('notes', acme)).toBeNull()
    expect(resolveProjectScopedCreate('https://github.com/notes/x', acme)).toBeNull()
  })

  it('never reads a link as a project path, even when a project is titled like its scheme', () => {
    const odd = catalog([repo('r-scheme', 'https:'), repo('r-notes', 'notes')])

    expect(resolveProjectScopedCreate('https:/issue', odd)?.repoId).toBe('r-scheme')
    expect(resolveProjectScopedCreate('https://github.com/notes/issues/4', odd)).toBeNull()
  })
})

describe('getProjectCreateLabel', () => {
  it('uses the repo name for a plain project', () => {
    expect(getProjectCreateLabel(repo('r-notes', 'notes'), acme)).toBe('notes')
  })

  it('uses the project group name when the repo belongs to one', () => {
    const web = repo('r-web', 'acme-web-checkout')
    const grouped: PaletteProjectCatalog = {
      repos: [web],
      projects: [
        {
          id: 'p-web',
          displayName: 'Acme Web',
          badgeColor: '#000',
          sourceRepoIds: ['r-web'],
          createdAt: 0,
          updatedAt: 0
        }
      ],
      projectHostSetups: [
        {
          id: 's-web',
          projectId: 'p-web',
          hostId: 'local',
          repoId: 'r-web',
          path: '/code/acme-web-checkout',
          displayName: 'acme-web-checkout',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 0,
          updatedAt: 0
        }
      ]
    }
    expect(getProjectCreateLabel(web, grouped)).toBe('Acme Web')
  })
})

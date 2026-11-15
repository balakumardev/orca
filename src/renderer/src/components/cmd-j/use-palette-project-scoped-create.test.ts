// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import type { Repo } from '../../../../shared/repo-types'
import { usePaletteProjectScopedCreate } from './use-palette-project-scoped-create'

const initialAppState = useAppStore.getInitialState()

function repo(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: `repo-${name}`,
    path: `/code/${name}`,
    displayName: name,
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

describe('what the plain Create row names', () => {
  beforeEach(() => {
    useAppStore.setState(
      {
        ...initialAppState,
        repos: [
          repo('acme-web'),
          repo('acme-api'),
          repo('notes'),
          repo('sketches', { kind: 'folder' })
        ],
        activeRepoId: 'repo-acme-web'
      },
      true
    )
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
  })

  const labelFor = (text: string) =>
    renderHook(() => usePaletteProjectScopedCreate(text)).result.current

  it('names the active project when the text names another project', () => {
    expect(labelFor('notes')).toEqual({
      repoId: 'repo-acme-web',
      projectLabel: 'acme-web',
      name: 'notes'
    })
  })

  it('names the active project even when the text matches it too', () => {
    expect(labelFor('acme')).toEqual({
      repoId: 'repo-acme-web',
      projectLabel: 'acme-web',
      name: 'acme'
    })
  })

  it('keeps the plain label when the text names no git project', () => {
    expect(labelFor('fix the login bug')).toBeNull()
    expect(labelFor('sketches')).toBeNull()
  })

  it('keeps the <project>/<name> reading when the text has that form', () => {
    expect(labelFor('notes/refactor')).toEqual({
      repoId: 'repo-notes',
      projectLabel: 'notes',
      name: 'refactor'
    })
  })

  it('keeps the plain label for an issue or pull request number or link, which Enter opens as that item', () => {
    useAppStore.setState({
      repos: [repo('42-app'), repo('acme-web')],
      activeRepoId: 'repo-acme-web'
    })
    expect(labelFor('42')).toBeNull()
    expect(labelFor('#42')).toBeNull()
    expect(labelFor('https://github.com/acme/web/issues/42')).toBeNull()
    expect(labelFor('42-app')).toEqual({
      repoId: 'repo-acme-web',
      projectLabel: 'acme-web',
      name: '42-app'
    })
  })

  it('names the first project when none is active', () => {
    useAppStore.setState({ activeRepoId: null })
    expect(labelFor('notes')).toMatchObject({ repoId: 'repo-acme-web', projectLabel: 'acme-web' })
  })
})

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  resolvePaletteComposerRepoId,
  selectPaletteComposerTargetState,
  waitUntilComposerTargetsRepo
} from './palette-composer-target'

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

function resolve(initialRepoId?: string): string {
  return resolvePaletteComposerRepoId(
    selectPaletteComposerTargetState(useAppStore.getState()),
    initialRepoId
  )
}

afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initialAppState, true)
})

describe('resolvePaletteComposerRepoId', () => {
  it('opens on the active project when the palette names none', () => {
    useAppStore.setState({
      repos: [repo('notes'), repo('acme-web')],
      activeRepoId: 'repo-acme-web'
    })
    expect(resolve()).toBe('repo-acme-web')
  })

  it('opens on the first project when nothing is active', () => {
    useAppStore.setState({ repos: [repo('notes'), repo('acme-web')], activeRepoId: null })
    expect(resolve()).toBe('repo-notes')
  })

  it('opens on the project the palette picked when the dialog can use it', () => {
    useAppStore.setState({
      repos: [repo('notes'), repo('acme-web')],
      activeRepoId: 'repo-acme-web'
    })
    expect(resolve('repo-notes')).toBe('repo-notes')
  })

  it('falls back to the active project when the picked one is not in the store', () => {
    useAppStore.setState({ repos: [repo('acme-web')], activeRepoId: 'repo-acme-web' })
    expect(resolve('repo-new')).toBe('repo-acme-web')
  })

  it('is empty when there is no project at all', () => {
    useAppStore.setState({ repos: [], activeRepoId: null })
    expect(resolve('repo-new')).toBe('')
  })
})

describe('waitUntilComposerTargetsRepo', () => {
  it('resolves true at once for a project the store already holds', async () => {
    useAppStore.setState({ repos: [repo('notes')] })
    await expect(waitUntilComposerTargetsRepo('repo-notes')).resolves.toBe(true)
  })

  it('resolves true when the project arrives later', async () => {
    useAppStore.setState({ repos: [repo('acme-web')], activeRepoId: 'repo-acme-web' })
    const pending = waitUntilComposerTargetsRepo('repo-notes')
    useAppStore.setState({ repos: [repo('acme-web'), repo('notes')] })
    await expect(pending).resolves.toBe(true)
  })

  it('resolves false when the project is still unknown at the deadline', async () => {
    vi.useFakeTimers()
    useAppStore.setState({ repos: [repo('acme-web')], activeRepoId: 'repo-acme-web' })
    const pending = waitUntilComposerTargetsRepo('repo-notes', 1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe(false)
  })
})

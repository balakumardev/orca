// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CREATE_WORKTREE_ITEM_ID } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { parseCmdJTaskSourceUrl } from '@/lib/workspace/search/worktrees/worktree-palette-task-url-match'
import { useAppStore } from '@/store/index'
import { useWorktreeJumpPaletteProjectCreateShortcut } from './use-worktree-jump-palette-project-create-shortcut'
import {
  endProjectNameStep,
  getProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import {
  entryIds,
  flushModalOpen,
  highlight,
  initialAppState,
  keyEvent,
  modEnter,
  openPaletteAt,
  projectCreateRowIds,
  seedProjects
} from './worktree-jump-palette-project-create-test-fixtures'

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

describe('Cmd+J "New worktree in <Project>" rows', () => {
  beforeEach(seedProjects)
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(initialAppState, true)
  })

  it('end the list above the plain Create row, and Enter does not arm them', async () => {
    const { result } = await openPaletteAt('acme-web')
    const ids = entryIds(result)
    const header = ids.indexOf('__header_extra_project-create__')

    expect(projectCreateRowIds(result)).toEqual(['repo-acme-web'])
    expect(ids.slice(0, header)).toEqual([
      '__header_worktrees__',
      expect.stringContaining('wt-web-auth'),
      expect.stringContaining('wt-web-docs'),
      expect.stringContaining('wt-web-main'),
      '__header_projects_groups__',
      'project:repo:repo-acme-web'
    ])
    expect(ids.slice(header)).toEqual([
      '__header_extra_project-create__',
      expect.stringContaining('project-create'),
      CREATE_WORKTREE_ITEM_ID
    ])
    expect(result.current.controller.commandSelectedItemId).toContain('wt-web')
  })

  it('come after the Folders section', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        folderSearch: {
          list: async () => ({
            entries: [{ path: '/code/acme-web-old', kind: 'folder' }],
            truncated: false
          }),
          resolve: async () => null
        }
      }
    })
    const { result } = await openPaletteAt('acme-web')
    const ids = entryIds(result)

    expect(ids).toEqual([
      '__header_worktrees__',
      expect.stringContaining('wt-web-auth'),
      expect.stringContaining('wt-web-docs'),
      expect.stringContaining('wt-web-main'),
      '__header_extra_folders__',
      expect.stringContaining('/code/acme-web-old'),
      '__header_projects_groups__',
      'project:repo:repo-acme-web',
      '__header_extra_project-create__',
      expect.stringContaining('project-create'),
      CREATE_WORKTREE_ITEM_ID
    ])
  })

  it('leave a project with no workspace armed on its project row, not on a Create row', async () => {
    const { result } = await openPaletteAt('notes')

    expect(entryIds(result)).toEqual([
      '__header_projects_groups__',
      'project:repo:repo-notes',
      '__header_extra_project-create__',
      expect.stringContaining('project-create'),
      CREATE_WORKTREE_ITEM_ID
    ])
    expect(result.current.controller.commandSelectedItemId).toBe('project:repo:repo-notes')
  })

  it('show the two best projects of a broader query, never an empty query', async () => {
    const broad = await openPaletteAt('acme')
    expect(projectCreateRowIds(broad.result)).toEqual(['repo-acme-web', 'repo-acme-api'])
    cleanup()

    const empty = await openPaletteAt('')
    expect(projectCreateRowIds(empty.result)).toEqual([])
  })

  it('are left to the Create row when the query reads <project>/<name>', async () => {
    const { result } = await openPaletteAt('acme-web/x')
    expect(projectCreateRowIds(result)).toEqual([])
  })

  it('are not offered for a folder project or a name that is no project', async () => {
    const folder = await openPaletteAt('sketches')
    expect(projectCreateRowIds(folder.result)).toEqual([])
    cleanup()

    const none = await openPaletteAt('zzquartz')
    expect(projectCreateRowIds(none.result)).toEqual([])
  })

  it('stay unarmed when the project has no workspace to take Enter first', async () => {
    const { result } = await openPaletteAt('notes')

    expect(projectCreateRowIds(result)).toEqual(['repo-notes'])
    expect(result.current.controller.commandSelectedItemId).not.toContain('project-create')
    expect(result.current.controller.commandSelectedItemId).toBe(
      result.current.controller.selectionItemIds.find((id) => !id.includes('project-create'))
    )
  })

  it('start the name step on their project when picked, and leave the palette open', async () => {
    const { result } = await openPaletteAt('notes')
    const entry = result.current.controller.listEntries.find(
      (candidate) => candidate.type === 'extra' && candidate.sourceId === 'project-create'
    )
    if (entry?.type !== 'extra') {
      throw new Error('no new-worktree row')
    }
    await act(async () => result.current.controller.handleSelectItem(entry))

    expect(getProjectNameStep()).toMatchObject({
      repoId: 'repo-notes',
      projectLabel: 'notes',
      projectPath: '/code/notes',
      name: ''
    })
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })
})

describe('Cmd/Ctrl+Enter on a row that belongs to a project', () => {
  beforeEach(seedProjects)
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    useAppStore.setState(initialAppState, true)
  })

  it('starts the name step for the project of a workspace row', async () => {
    const palette = await openPaletteAt('acme-web')
    await highlight(palette.result, (id) => id.includes('wt-web-auth'))
    const event = modEnter()

    expect(palette.result.current.shortcut.projectRepoId).toBe('repo-acme-web')
    let handled = false
    await act(async () => {
      handled = palette.result.current.shortcut.handleKeyDown(event)
    })

    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(getProjectNameStep()).toMatchObject({
      repoId: 'repo-acme-web',
      projectLabel: 'acme-web',
      name: ''
    })
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it('with Shift starts the name step for the project of the workspace you are in', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-web-auth' })
    const palette = await openPaletteAt('notes')
    expect(palette.result.current.shortcut.projectRepoId).toBe('repo-notes')
    expect(palette.result.current.shortcut.currentProjectRepoId).toBe('repo-acme-web')

    await act(async () => {
      palette.result.current.shortcut.handleKeyDown(keyEvent({ shiftKey: true }))
    })

    expect(getProjectNameStep()).toMatchObject({ repoId: 'repo-acme-web', name: '' })
  })

  it('with Shift does nothing when the workspace you are in belongs to no git project', async () => {
    useAppStore.setState({ activeWorktreeId: null })
    const palette = await openPaletteAt('acme-web')
    expect(palette.result.current.shortcut.currentProjectRepoId).toBeNull()
    expect(palette.result.current.shortcut.handleKeyDown(keyEvent({ shiftKey: true }))).toBe(false)
    expect(getProjectNameStep()).toBeNull()
  })

  it('does nothing special on a row with no project, and without the modifier key', async () => {
    const palette = await openPaletteAt('acme-web')
    await highlight(palette.result, (id) => id === CREATE_WORKTREE_ITEM_ID)
    expect(palette.result.current.shortcut.projectRepoId).toBeNull()
    expect(palette.result.current.shortcut.handleKeyDown(modEnter())).toBe(false)

    await highlight(palette.result, (id) => id.includes('wt-web-auth'))
    const plainEnter = keyEvent({ metaKey: false, ctrlKey: false })
    expect(palette.result.current.shortcut.handleKeyDown(plainEnter)).toBe(false)
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it('swallows the chord without opening anything while the list still shows an earlier query', async () => {
    const palette = await openPaletteAt('acme-web')
    await highlight(palette.result, (id) => id.includes('wt-web-auth'))
    palette.result.current.controller.liveQueryRef.current = 'acme-web2'

    expect(palette.result.current.shortcut.handleKeyDown(modEnter())).toBe(true)
    expect(getProjectNameStep()).toBeNull()
  })

  it('swallows a held chord and a chord the input method is handling, and starts nothing', async () => {
    const palette = await openPaletteAt('acme-web')
    await highlight(palette.result, (id) => id.includes('wt-web-auth'))

    expect(palette.result.current.shortcut.handleKeyDown(modEnter({ repeat: true }))).toBe(true)
    expect(getProjectNameStep()).toBeNull()
    expect(palette.result.current.shortcut.handleKeyDown(modEnter({ keyCode: 229 }))).toBe(false)
    expect(palette.result.current.shortcut.handleKeyDown(keyEvent({ isComposing: true }))).toBe(
      false
    )
    expect(getProjectNameStep()).toBeNull()
  })

  it('names the project the highlighted row and the current workspace belong to', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-web-main' })
    const palette = await openPaletteAt('notes')
    expect(palette.result.current.shortcut.projectLabel).toBe('notes')
    expect(palette.result.current.shortcut.currentProjectLabel).toBe('acme-web')
    expect(palette.result.current.shortcut.rowHintLabel).toBe('notes')
    expect(palette.result.current.shortcut.currentHintLabel).toBe('acme-web')
  })

  it('names the project once when the highlighted row and the workspace you are in share it', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-web-main' })
    const palette = await openPaletteAt('acme-web')
    await highlight(palette.result, (id) => id.includes('wt-web-auth'))
    expect(palette.result.current.shortcut.rowHintLabel).toBe('acme-web')
    expect(palette.result.current.shortcut.currentHintLabel).toBeNull()
  })

  it('names the project of the highlighted row with an empty search too', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-web-main' })
    const empty = await openPaletteAt('')
    expect(empty.result.current.shortcut.rowHintLabel).toBe('acme-web')
    expect(empty.result.current.shortcut.currentHintLabel).toBeNull()
  })

  it('leaves a pasted issue or PR link to its own Create row, for both chords', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-web-main' })
    const palette = await openPaletteAt('acme-web')
    await highlight(palette.result, (id) => id.includes('wt-web-auth'))
    const { controller } = palette.result.current
    const link = parseCmdJTaskSourceUrl('https://github.com/acme/acme-web/issues/12')
    expect(link).not.toBeNull()

    // The same highlighted workspace row and the same current workspace, once with a link in the search.
    const plain = renderHook(() => useWorktreeJumpPaletteProjectCreateShortcut(controller))
    expect(plain.result.current.projectRepoId).toBe('repo-acme-web')
    expect(plain.result.current.currentProjectRepoId).toBe('repo-acme-web')

    const withLink = renderHook(() =>
      useWorktreeJumpPaletteProjectCreateShortcut({ ...controller, taskSourceUrl: link })
    )
    expect(withLink.result.current.projectRepoId).toBeNull()
    expect(withLink.result.current.currentProjectRepoId).toBeNull()
    expect(withLink.result.current.handleKeyDown(modEnter())).toBe(false)
    expect(withLink.result.current.handleKeyDown(keyEvent({ shiftKey: true }))).toBe(false)
    expect(getProjectNameStep()).toBeNull()
  })
})

describe('Create row for <project>/<name>', () => {
  beforeEach(seedProjects)
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    useAppStore.setState(initialAppState, true)
  })

  async function createFor(query: string) {
    const palette = await openPaletteAt(query)
    await act(async () => palette.result.current.controller.handleCreateWorktree())
    await flushModalOpen()
    return palette
  }

  it('starts the name step with the name filled in, and creates nothing', async () => {
    await createFor('acme-web/fix login')

    expect(getProjectNameStep()).toMatchObject({
      repoId: 'repo-acme-web',
      projectLabel: 'acme-web',
      name: 'fix login',
      projectPath: '/code/acme-web'
    })
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it('scopes only on the whole project title, ignoring case, never on a prefix', async () => {
    await createFor('ACME-WEB/fix login')
    expect(getProjectNameStep()).toMatchObject({ repoId: 'repo-acme-web', name: 'fix login' })
    endProjectNameStep()
    cleanup()
    useAppStore.setState({ ...useAppStore.getState(), activeModal: 'worktree-palette' })

    // A branch-style name whose first part only starts a project title stays a plain name.
    await createFor('acme-w/fix')
    expect(getProjectNameStep()).toBeNull()
    expect(useAppStore.getState().modalData).toEqual({
      prefilledName: 'acme-w/fix',
      telemetrySource: 'command_palette'
    })
  })

  it('keeps the whole query as the name when the project part matches no single project', async () => {
    await createFor('acme/fix-login')
    expect(getProjectNameStep()).toBeNull()
    expect(useAppStore.getState().modalData).toEqual({
      prefilledName: 'acme/fix-login',
      telemetrySource: 'command_palette'
    })
    cleanup()
    useAppStore.setState({ ...useAppStore.getState(), activeModal: 'worktree-palette' })
    await createFor('plain-name')
    expect(useAppStore.getState().modalData).toEqual({
      prefilledName: 'plain-name',
      telemetrySource: 'command_palette'
    })
  })
})

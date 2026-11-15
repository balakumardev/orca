// @vitest-environment happy-dom

import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCmdJTaskSourceUrl } from '@/lib/workspace/search/worktrees/worktree-palette-task-url-match'
import { useAppStore } from '@/store/index'
import { useWorktreeJumpPaletteProjectCreateShortcut } from './use-worktree-jump-palette-project-create-shortcut'
import {
  endProjectNameStep,
  getProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import {
  WorktreeJumpPaletteFolderAddChip,
  WorktreeJumpPaletteProjectChip
} from './worktree-jump-palette-project-create-chip'
import {
  highlight,
  initialAppState,
  modEnter,
  openPaletteAt,
  project,
  seedProjects,
  type Palette
} from './worktree-jump-palette-project-create-test-fixtures'

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/components/onboarding/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: vi.fn(async () => ({}))
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

const FOLDERS: FolderSearchEntry[] = [
  { path: '/code/zeta-app', kind: 'git-root' },
  { path: '/code/zeta-linked', kind: 'linked-worktree' },
  { path: '/code/zeta-plain', kind: 'folder' }
]

function installFolderBridge(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      folderSearch: {
        list: async () => ({ entries: FOLDERS, truncated: false }),
        resolve: async (path: string) => FOLDERS.find((entry) => entry.path === path) ?? null
      }
    }
  })
}

function installAddProject(): ReturnType<typeof vi.fn> {
  const addRepoPath = vi.fn(async (path: string) => {
    const added = project('zeta-app', { path })
    useAppStore.setState({ repos: [...useAppStore.getState().repos, added] })
    return added
  })
  const fetchWorktrees = vi.fn()
  fetchWorktrees.mockResolvedValue(true)
  useAppStore.setState({ addRepoPath, fetchWorktrees })
  return addRepoPath
}

const isFolderRow = (path: string) => (id: string) => id.includes(`folders`) && id.endsWith(path)
const chipIn = (container: Element) =>
  container.querySelector('[data-slot="palette-new-worktree-chip"]')

function ChipProbe({
  palette,
  rowId,
  which
}: {
  palette: Palette
  rowId: (id: string) => boolean
  which: 'project' | 'folder'
}) {
  const { controller } = palette.current
  const index = controller.listEntries.findIndex((entry) => rowId(entry.id))
  const Chip =
    which === 'project' ? WorktreeJumpPaletteProjectChip : WorktreeJumpPaletteFolderAddChip
  return (
    <Chip
      entry={controller.listEntries[index]}
      renderKey={controller.listEntryRenderKeys[index]}
      controller={controller}
    />
  )
}

describe('Cmd/Ctrl+Enter on a Folders row', () => {
  beforeEach(() => {
    seedProjects()
    installFolderBridge()
  })
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(initialAppState, true)
  })

  it('adds an untracked git root and starts the name step on the new project', async () => {
    const addRepoPath = installAddProject()
    const palette = await openPaletteAt('zeta')
    await highlight(palette.result, isFolderRow('/code/zeta-app'))
    expect(palette.result.current.shortcut.folderAddsProject).toBe(true)
    expect(palette.result.current.shortcut.projectRepoId).toBeNull()

    const event = modEnter()
    let handled = false
    await act(async () => {
      handled = palette.result.current.shortcut.handleKeyDown(event)
    })
    await vi.waitFor(() => expect(getProjectNameStep()).not.toBeNull())

    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(addRepoPath).toHaveBeenCalledExactlyOnceWith('/code/zeta-app', 'git', {
      runtimeEnvironmentId: null
    })
    expect(getProjectNameStep()).toMatchObject({
      repoId: 'repo-zeta-app',
      projectLabel: 'zeta-app',
      projectPath: '/code/zeta-app',
      name: ''
    })
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it('drops the row once its project is added, so a second press cannot offer it again', async () => {
    installAddProject()
    const palette = await openPaletteAt('zeta')
    await highlight(palette.result, isFolderRow('/code/zeta-app'))
    await act(async () => {
      palette.result.current.shortcut.handleKeyDown(modEnter())
    })
    await vi.waitFor(() => expect(getProjectNameStep()).not.toBeNull())
    endProjectNameStep()

    const folderRowPaths = () =>
      FOLDERS.map((entry) => entry.path).filter((path) =>
        palette.result.current.controller.listEntries.some((row) => isFolderRow(path)(row.id))
      )
    await vi.waitFor(() =>
      expect(folderRowPaths()).toEqual(['/code/zeta-linked', '/code/zeta-plain'])
    )
  })

  it('does nothing special on a linked worktree or a plain folder row', async () => {
    const addRepoPath = installAddProject()
    const palette = await openPaletteAt('zeta')

    for (const path of ['/code/zeta-linked', '/code/zeta-plain']) {
      await highlight(palette.result, isFolderRow(path))
      expect(palette.result.current.shortcut.folderAddsProject).toBe(false)
      expect(palette.result.current.shortcut.handleKeyDown(modEnter())).toBe(false)
    }
    expect(addRepoPath).not.toHaveBeenCalled()
  })

  it('swallows a held key without adding anything', async () => {
    const addRepoPath = installAddProject()
    const palette = await openPaletteAt('zeta')
    await highlight(palette.result, isFolderRow('/code/zeta-app'))

    let handled = false
    await act(async () => {
      handled = palette.result.current.shortcut.handleKeyDown(modEnter({ repeat: true }))
    })

    expect(handled).toBe(true)
    expect(addRepoPath).not.toHaveBeenCalled()
    expect(getProjectNameStep()).toBeNull()
  })

  it('leaves a pasted issue or PR link to its own Create row', async () => {
    const addRepoPath = installAddProject()
    const palette = await openPaletteAt('zeta')
    await highlight(palette.result, isFolderRow('/code/zeta-app'))
    const link = parseCmdJTaskSourceUrl('https://github.com/acme/acme-web/issues/12')
    expect(link).not.toBeNull()

    const withLink = renderHook(() =>
      useWorktreeJumpPaletteProjectCreateShortcut({
        ...palette.result.current.controller,
        taskSourceUrl: link
      })
    )

    expect(withLink.result.current.folderAddsProject).toBe(false)
    expect(withLink.result.current.handleKeyDown(modEnter())).toBe(false)
    expect(addRepoPath).not.toHaveBeenCalled()
  })
})

describe('the Cmd+Enter chip on the highlighted row', () => {
  beforeEach(() => {
    seedProjects()
    installFolderBridge()
  })
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(initialAppState, true)
  })

  it('shows on the highlighted workspace row only', async () => {
    const palette = await openPaletteAt('acme-web')
    const isDocs = (id: string) => id.includes('wt-web-docs')
    const probe = () => <ChipProbe palette={palette.result} rowId={isDocs} which="project" />

    const idle = render(probe())
    expect(chipIn(idle.container)).toBeNull()
    idle.unmount()

    await highlight(palette.result, isDocs)
    expect(chipIn(render(probe()).container)).not.toBeNull()
  })

  it('shows on the project row of a repository project, never on a folder project', async () => {
    const repoPalette = await openPaletteAt('notes')
    const isProjectRow = (id: string) => id === 'project:repo:repo-notes'
    await highlight(repoPalette.result, isProjectRow)
    const onRepo = render(
      <ChipProbe palette={repoPalette.result} rowId={isProjectRow} which="project" />
    )
    expect(chipIn(onRepo.container)).not.toBeNull()
    onRepo.unmount()

    const folder = await openPaletteAt('sketches')
    const isFolderProject = (id: string) => id === 'project:repo:repo-sketches'
    await highlight(folder.result, isFolderProject)
    expect(
      chipIn(
        render(<ChipProbe palette={folder.result} rowId={isFolderProject} which="project" />)
          .container
      )
    ).toBeNull()
  })

  it('shows on an untracked repository row, and on no other folder row', async () => {
    const palette = await openPaletteAt('zeta')
    const expectations: [path: string, shown: boolean][] = [
      ['/code/zeta-app', true],
      ['/code/zeta-linked', false],
      ['/code/zeta-plain', false]
    ]
    for (const [path, shown] of expectations) {
      await highlight(palette.result, isFolderRow(path))
      expect(palette.result.current.controller.commandSelectedItemId).toContain(path)
      const probe = render(
        <ChipProbe palette={palette.result} rowId={isFolderRow(path)} which="folder" />
      )
      expect(chipIn(probe.container) !== null).toBe(shown)
      probe.unmount()
    }
  })
})

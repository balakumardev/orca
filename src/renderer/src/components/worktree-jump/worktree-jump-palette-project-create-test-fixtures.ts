import { act, renderHook } from '@testing-library/react'
import type React from 'react'
import { useMemo } from 'react'
import { expect, vi } from 'vitest'
import { createWorktreePaletteRequestGuard } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { useAppStore } from '@/store/index'
import type { Repo } from '../../../../shared/repository/repo-types'
import { useWorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { useWorktreeJumpPaletteNameStep } from './use-worktree-jump-palette-name-step'
import { useWorktreeJumpPaletteProjectCreateShortcut } from './use-worktree-jump-palette-project-create-shortcut'
import { makeWorktree } from './worktree-jump-palette-test-fixtures'

export const initialAppState = useAppStore.getInitialState()

export function project(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: `repo-${name}`,
    path: `/code/${name}`,
    displayName: name,
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

export function seedProjects(): void {
  const web = (id: string, name: string, main = false) =>
    makeWorktree(id, name, { repoId: 'repo-acme-web', isMainWorktree: main, path: `/code/${id}` })
  useAppStore.setState(
    {
      ...initialAppState,
      repos: [
        project('acme-web'),
        project('acme-api'),
        project('acme-docs'),
        project('notes'),
        project('sketches', { kind: 'folder' })
      ],
      worktreesByRepo: {
        'repo-acme-web': [
          web('wt-web-main', 'main', true),
          web('wt-web-auth', 'auth-flow'),
          web('wt-web-docs', 'docs-refresh')
        ]
      },
      settings: { ...initialAppState.settings!, botsEnabled: false },
      showSleepingWorkspaces: true,
      activeModal: 'worktree-palette',
      prefetchWorktreeCreateBase: vi.fn(async () => {}),
      recordFeatureInteraction: vi.fn(async () => {})
    },
    true
  )
}

export function usePalette() {
  const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])
  const controller = useWorktreeJumpPaletteController({
    visible: true,
    lingering: true,
    createLookupGuard
  })
  return {
    controller,
    shortcut: useWorktreeJumpPaletteProjectCreateShortcut(controller),
    nameStep: useWorktreeJumpPaletteNameStep(controller)
  }
}

export async function openPaletteAt(query: string) {
  const hook = renderHook(usePalette)
  await act(async () => {})
  await act(async () => hook.result.current.controller.handleQueryChange(query))
  await act(async () => {})
  return hook
}

export type Palette = Awaited<ReturnType<typeof openPaletteAt>>['result']

export const projectCreateRowIds = (palette: Palette): string[] =>
  palette.current.controller.listEntries.flatMap((entry) =>
    entry.type === 'extra' && entry.sourceId === 'project-create' ? [entry.result.id] : []
  )

export const entryIds = (palette: Palette): string[] =>
  palette.current.controller.listEntries.map((entry) => entry.id)

type FakeKeyEvent = {
  key: string
  keyCode: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  repeat: boolean
  nativeEvent: { isComposing: boolean }
  preventDefault: () => void
  stopPropagation: () => void
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only key, keyCode, the modifiers, repeat, isComposing and the two stop calls.
const asKeyEvent = (event: FakeKeyEvent): React.KeyboardEvent => event as React.KeyboardEvent

export function keyEvent(
  overrides: {
    key?: string
    keyCode?: number
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
    repeat?: boolean
    isComposing?: boolean
  } = {}
): React.KeyboardEvent {
  const { isComposing = false, ...rest } = overrides
  return asKeyEvent({
    key: 'Enter',
    keyCode: 13,
    metaKey: true,
    ctrlKey: true,
    shiftKey: false,
    repeat: false,
    nativeEvent: { isComposing },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...rest
  })
}

export const createInteractionCount = (): number =>
  vi
    .mocked(useAppStore.getState().recordFeatureInteraction)
    .mock.calls.filter(([feature]) => feature === 'cmd-j-create-workspace').length

export const modEnter = (
  overrides: { repeat?: boolean; keyCode?: number } = {}
): React.KeyboardEvent => keyEvent(overrides)

export async function highlight(palette: Palette, match: (id: string) => boolean): Promise<void> {
  const { listEntries, listEntryRenderKeys } = palette.current.controller
  const index = listEntries.findIndex((entry) => match(entry.id))
  expect(index).toBeGreaterThanOrEqual(0)
  await act(async () => palette.current.controller.setSelectedItemId(listEntryRenderKeys[index]))
}

export async function flushModalOpen(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

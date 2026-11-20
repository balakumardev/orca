// @vitest-environment happy-dom

import { act, cleanup } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  endProjectNameStep,
  getProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import {
  createInteractionCount,
  flushModalOpen,
  highlight,
  initialAppState,
  keyEvent,
  modEnter,
  openPaletteAt,
  seedProjects
} from './worktree-jump-palette-project-create-test-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/components/settings/navigation/useSettingsNavigationMetadata', () => ({
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

const plain = (key: string, overrides: { repeat?: boolean; keyCode?: number } = {}) =>
  keyEvent({ key, keyCode: 0, metaKey: false, ctrlKey: false, ...overrides })

async function openStep(name = '', query = 'acme-web') {
  const palette = await openPaletteAt(query)
  await highlight(palette.result, (id) => id.includes('wt-web-auth'))
  await act(async () => {
    palette.result.current.shortcut.handleKeyDown(modEnter())
  })
  if (name) {
    await act(async () => palette.result.current.nameStep.inputProps.onValueChange?.(name))
  }
  return palette
}
type Step = Awaited<ReturnType<typeof openStep>>
const press = (palette: Step, event: ReturnType<typeof keyEvent>) =>
  act(async () => {
    palette.result.current.nameStep.handleKeyDown(event)
  })
const openModalCalls = (): number => vi.mocked(useAppStore.getState().openModal).mock.calls.length

describe('The Cmd+J name step', () => {
  beforeEach(() => {
    seedProjects()
    useAppStore.setState({ openModal: vi.fn(useAppStore.getState().openModal) })
    vi.mocked(toast.error).mockClear()
  })
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    useAppStore.setState(initialAppState, true)
  })

  it('shows the project in the input prompt, with its own icon and no filter button', async () => {
    const palette = await openStep('login-fix')
    const { inputProps, hiddenProps } = palette.result.current.nameStep

    expect(inputProps.value).toBe('login-fix')
    expect(inputProps.placeholder).toBe('New worktree in acme-web - type a name')
    expect(inputProps.icon).toBeDefined()
    expect(inputProps.trailing).toBeNull()
    expect(hiddenProps).toEqual({ style: { display: 'none' } })
  })

  it('hands the project and name to the New worktree dialog on Enter, and closes the palette', async () => {
    const palette = await openStep('  login-fix ')
    await press(palette, plain('Enter'))
    await flushModalOpen()

    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toEqual({
      initialRepoId: 'repo-acme-web',
      prefilledName: 'login-fix',
      autoSubmit: true,
      telemetrySource: 'command_palette'
    })
    expect(getProjectNameStep()).toBeNull()
    expect(createInteractionCount()).toBe(1)
  })

  it('hands off once when Enter arrives twice before the palette has closed', async () => {
    const palette = await openStep('login-fix')
    await act(async () => {
      palette.result.current.nameStep.handleKeyDown(plain('Enter'))
      palette.result.current.nameStep.handleKeyDown(plain('Enter'))
    })
    await flushModalOpen()

    expect(openModalCalls()).toBe(1)
    expect(createInteractionCount()).toBe(1)
  })

  it('does nothing on Enter with an empty or blank name', async () => {
    const palette = await openStep()
    await press(palette, plain('Enter'))
    await act(async () => palette.result.current.nameStep.inputProps.onValueChange?.('   '))
    await press(palette, plain('Enter'))
    await flushModalOpen()

    expect(openModalCalls()).toBe(0)
    expect(getProjectNameStep()).not.toBeNull()
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it('does not hand off on a held Enter or on Cmd+Enter', async () => {
    const palette = await openStep('login-fix')
    await press(palette, keyEvent({ key: 'Enter', metaKey: false, ctrlKey: false, repeat: true }))
    await press(palette, modEnter())
    await flushModalOpen()

    expect(openModalCalls()).toBe(0)
    expect(getProjectNameStep()).not.toBeNull()
  })

  it('leaves keys an input method is handling alone', async () => {
    const palette = await openStep('login-fix')
    const event = (key: string, init: { keyCode?: number; isComposing?: boolean }) =>
      keyEvent({ key, metaKey: false, ctrlKey: false, ...init })
    const { handleKeyDown } = palette.result.current.nameStep

    for (const key of ['Enter', 'Escape', 'Backspace']) {
      expect(handleKeyDown(event(key, { keyCode: 229 }))).toBe(false)
      expect(handleKeyDown(event(key, { isComposing: true }))).toBe(false)
    }
    await flushModalOpen()
    expect(openModalCalls()).toBe(0)
    expect(getProjectNameStep()).not.toBeNull()
  })

  it('returns to the search text on Escape and on Backspace in an empty name', async () => {
    const palette = await openStep('ab')
    await press(palette, plain('Backspace'))
    expect(getProjectNameStep()).not.toBeNull()
    await act(async () => palette.result.current.nameStep.handleOpenChange(false))
    expect(getProjectNameStep()).toBeNull()
    expect(palette.result.current.controller.query).toBe('acme-web')
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')

    await act(async () => {
      palette.result.current.shortcut.handleKeyDown(modEnter())
    })
    await press(palette, plain('Backspace'))
    expect(getProjectNameStep()).toBeNull()
    expect(palette.result.current.controller.query).toBe('acme-web')
  })

  it('keeps the search text when a held Backspace has just emptied the name', async () => {
    const palette = await openStep('a')
    await act(async () => palette.result.current.nameStep.inputProps.onValueChange?.(''))
    await press(palette, plain('Backspace', { repeat: true }))
    expect(getProjectNameStep()).not.toBeNull()

    await press(palette, plain('Backspace'))
    expect(getProjectNameStep()).toBeNull()
  })

  it('swallows the repeats of a Backspace held through the exit, so the search text stays whole', async () => {
    const palette = await openStep()
    const { handleKeyDown } = palette.result.current.nameStep
    await press(palette, plain('Backspace'))
    expect(getProjectNameStep()).toBeNull()
    expect(palette.result.current.controller.query).toBe('acme-web')

    for (let held = 0; held < 3; held += 1) {
      const repeat = plain('Backspace', { repeat: true })
      expect(handleKeyDown(repeat)).toBe(true)
      expect(repeat.preventDefault).toHaveBeenCalledTimes(1)
      expect(repeat.stopPropagation).toHaveBeenCalledTimes(1)
    }
    // A fresh press, or any other key, edits the search text again.
    expect(handleKeyDown(plain('Backspace'))).toBe(false)
    expect(handleKeyDown(plain('Backspace', { repeat: true }))).toBe(false)
  })

  it('lets a repeated Backspace through when the step was left some other way', async () => {
    const palette = await openStep()
    await act(async () => palette.result.current.nameStep.handleOpenChange(false))
    expect(getProjectNameStep()).toBeNull()

    expect(
      palette.result.current.nameStep.handleKeyDown(plain('Backspace', { repeat: true }))
    ).toBe(false)
  })

  it('stops the list keys and leaves Home and End to the text caret', async () => {
    const palette = await openStep('login-fix')
    const { handleKeyDown } = palette.result.current.nameStep

    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Tab']) {
      const event = plain(key)
      expect(handleKeyDown(event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    }
    for (const key of ['Home', 'End']) {
      const event = plain(key)
      expect(handleKeyDown(event)).toBe(true)
      expect(event.stopPropagation).toHaveBeenCalledTimes(1)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(handleKeyDown(plain('a'))).toBe(false)
  })

  it('leaves the step with a toast, and creates nothing, when the project was removed meanwhile', async () => {
    const palette = await openStep('login-fix')
    useAppStore.setState({
      repos: useAppStore.getState().repos.filter((repo) => repo.id !== 'repo-acme-web')
    })
    await press(palette, plain('Enter'))
    await flushModalOpen()

    expect(toast.error).toHaveBeenCalledWith('That project is no longer there')
    expect(openModalCalls()).toBe(0)
    expect(getProjectNameStep()).toBeNull()
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })
})

describe('Leaving the name step with a folder under the search', () => {
  const folderRowId = (palette: Step): string =>
    palette.result.current.controller.selectionItemIds.find((id) => id.includes('folders')) ?? ''

  beforeEach(() => {
    seedProjects()
    useAppStore.setState({ activeWorktreeId: 'wt-web-main' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        folderSearch: {
          list: async () => ({
            entries: [{ path: '/code/zqx-docs', kind: 'folder' }],
            truncated: false
          }),
          resolve: async () => null
        }
      }
    })
  })
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(initialAppState, true)
  })

  async function openFolderSearch() {
    const palette = await openPaletteAt('zqx-do')
    await act(async () => {})
    expect(folderRowId(palette)).not.toBe('')
    await act(async () => {
      palette.result.current.shortcut.handleKeyDown(keyEvent({ shiftKey: true }))
    })
    expect(getProjectNameStep()).not.toBeNull()
    return palette
  }
  // What cmdk does after the input value changes: it reports its first row as the highlight.
  const cmdkPicksFirstRow = (palette: Step) =>
    act(async () =>
      palette.result.current.controller.handleCommandSelectionChange(folderRowId(palette))
    )
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
    })

  it('keeps the folder unarmed after Escape', async () => {
    const palette = await openFolderSearch()
    await act(async () => palette.result.current.nameStep.handleOpenChange(false))
    await cmdkPicksFirstRow(palette)

    expect(palette.result.current.controller.commandSelectedItemId).not.toContain('folders')
  })

  it('keeps the folder unarmed when move keys were pressed in the step', async () => {
    const palette = await openFolderSearch()
    await press('ArrowDown')
    await press('Home')
    await press('n', { ctrlKey: true })
    await act(async () => palette.result.current.nameStep.handleOpenChange(false))
    await cmdkPicksFirstRow(palette)

    expect(palette.result.current.controller.commandSelectedItemId).not.toContain('folders')
  })

  it('forgets a move made before the step, as typing a new query does', async () => {
    const palette = await openPaletteAt('zqx-do')
    await press('ArrowDown')
    await act(async () => {
      palette.result.current.shortcut.handleKeyDown(keyEvent({ shiftKey: true }))
    })
    await act(async () => palette.result.current.nameStep.handleOpenChange(false))
    await cmdkPicksFirstRow(palette)

    expect(palette.result.current.controller.commandSelectedItemId).not.toContain('folders')
  })
})

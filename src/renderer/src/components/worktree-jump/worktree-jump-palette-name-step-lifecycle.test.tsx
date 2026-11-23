// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginProjectNameStep,
  endProjectNameStep,
  getProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import { useAppStore } from '@/store/index'
import { useWorktreeJumpPaletteNameStep } from './use-worktree-jump-palette-name-step'
import {
  flushModalOpen,
  initialAppState,
  keyEvent,
  seedProjects
} from './worktree-jump-palette-project-create-test-fixtures'

vi.mock('@/components/settings/navigation/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

type StepProps = { visible: boolean }

function mountStep(initial: StepProps = { visible: true }) {
  const skipRestoreFocusRef = { current: false }
  const closeModal = vi.fn()
  const setSelectedItemId = vi.fn()
  const hook = renderHook(
    ({ visible }: StepProps) =>
      useWorktreeJumpPaletteNameStep({
        closeModal,
        handleOpenChange: vi.fn(),
        handleQueryChange: vi.fn(),
        query: 'acme-web',
        setSelectedItemId,
        skipRestoreFocusRef,
        visible
      }),
    { initialProps: initial }
  )
  return { hook, skipRestoreFocusRef, closeModal, setSelectedItemId }
}

const enter = () => keyEvent({ key: 'Enter', keyCode: 0, metaKey: false, ctrlKey: false })

describe('The Cmd+J name step, around the palette', () => {
  beforeEach(() => {
    seedProjects()
    useAppStore.setState({ openModal: vi.fn() })
  })
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('starts only while the palette is the open modal, so a stray call leaves no step behind', () => {
    useAppStore.setState({ activeModal: 'none' })
    beginProjectNameStep({ repoId: 'repo-acme-web', projectLabel: 'acme-web' })

    expect(getProjectNameStep()).toBeNull()

    useAppStore.setState({ activeModal: 'worktree-palette' })
    beginProjectNameStep({ repoId: 'repo-acme-web', projectLabel: 'acme-web' })

    expect(getProjectNameStep()).toMatchObject({
      repoId: 'repo-acme-web',
      projectPath: '/code/acme-web'
    })
  })

  it('ends when the palette is hidden, so the next Cmd+J opens on the search', () => {
    const { hook } = mountStep()
    act(() => beginProjectNameStep({ repoId: 'repo-acme-web', projectLabel: 'acme-web' }))
    expect(hook.result.current.step).not.toBeNull()

    hook.rerender({ visible: false })

    expect(getProjectNameStep()).toBeNull()
    expect(hook.result.current.step).toBeNull()
  })

  it('stays while the palette stays visible', () => {
    const { hook } = mountStep()
    act(() => beginProjectNameStep({ repoId: 'repo-acme-web', projectLabel: 'acme-web' }))
    hook.rerender({ visible: true })

    expect(getProjectNameStep()).not.toBeNull()
  })

  it('hands the name over without restoring focus to the palette and without its fade-out', async () => {
    const content = document.createElement('div')
    content.dataset.slot = 'command-dialog-content'
    const overlay = document.createElement('div')
    document.body.append(overlay, content)
    const { hook, skipRestoreFocusRef, closeModal, setSelectedItemId } = mountStep()
    act(() => beginProjectNameStep({ repoId: 'repo-acme-web', projectLabel: 'acme-web' }))
    await act(async () => hook.result.current.inputProps.onValueChange?.('login-fix'))
    await act(async () => {
      hook.result.current.handleKeyDown(enter())
    })
    await flushModalOpen()

    expect(skipRestoreFocusRef.current).toBe(true)
    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(setSelectedItemId).toHaveBeenCalledWith('')
    expect(content.style.animation).toBe('none')
    expect(overlay.style.animation).toBe('none')
    expect(getProjectNameStep()).toBeNull()
  })

  it('leaves the palette focus and fade alone when Enter has nothing to hand over', async () => {
    const content = document.createElement('div')
    content.dataset.slot = 'command-dialog-content'
    document.body.append(document.createElement('div'), content)
    const { hook, skipRestoreFocusRef, closeModal } = mountStep()
    act(() => beginProjectNameStep({ repoId: 'repo-acme-web', projectLabel: 'acme-web' }))
    await act(async () => {
      hook.result.current.handleKeyDown(enter())
    })

    expect(skipRestoreFocusRef.current).toBe(false)
    expect(closeModal).not.toHaveBeenCalled()
    expect(content.style.animation).toBe('')
  })
})

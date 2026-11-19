// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { openProjectComposer } from '@/components/cmd-j/palette-project-create-composer'
import {
  beginProjectNameStep,
  endProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import { useWorktreeJumpPaletteNameStep } from '../worktree-jump/use-worktree-jump-palette-name-step'
import {
  initialAppState,
  keyEvent,
  replaceProjectCreateRuntime,
  seedHostCollisionProjects
} from '../worktree-jump/worktree-jump-palette-project-create-test-fixtures'
import type { ComposerModalData } from './composer-modal-data'
import { useComposerAutoSubmit } from './use-composer-auto-submit'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  seedHostCollisionProjects()
})
afterEach(() => {
  cleanup()
  endProjectNameStep()
  vi.useRealTimers()
  useAppStore.setState(initialAppState, true)
})

async function openHiddenComposer() {
  await act(async () =>
    openProjectComposer('repo-acme-web', 'remote-fix', true, {
      projectId: 'project-web',
      hostId: 'runtime:server-a',
      projectHostSetupId: 'setup-remote'
    })
  )
  return mountWaitingComposer()
}

function mountWaitingComposer() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openProjectComposer just opened this modal with ComposerModalData.
  const modalData = useAppStore.getState().modalData as ComposerModalData
  return renderHook(
    (createDisabled: boolean) =>
      useComposerAutoSubmit({
        modalData,
        createDisabled,
        create: async () => {
          useAppStore.getState().closeModal()
        },
        target: {
          repoId: 'repo-acme-web',
          selectedProjectId: 'project-web',
          selectedRepoExecutionHostId: 'runtime:server-a',
          selectedProjectHostSetupId: 'setup-remote'
        }
      }),
    { initialProps: true }
  )
}

it('creates only while the authority captured at composer open remains current', async () => {
  const original = await openHiddenComposer()
  original.rerender(false)
  await act(async () => {})
  expect(useAppStore.getState().activeModal).toBe('none')
  original.unmount()

  const waiting = await openHiddenComposer()
  act(replaceProjectCreateRuntime)
  waiting.rerender(false)
  await act(async () => {})

  expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  expect(useAppStore.getState().modalData).toMatchObject({
    initialRepoId: 'repo-acme-web',
    initialWorkspaceTarget: {
      projectId: 'project-web',
      hostId: 'runtime:server-a',
      projectHostSetupId: 'setup-remote'
    },
    prefilledName: 'remote-fix'
  })
  expect(useAppStore.getState().modalData).not.toHaveProperty('autoSubmit')
})

it('keeps the name-step authority when the pairing changes during the composer handoff', async () => {
  const nameStep = renderHook(() =>
    useWorktreeJumpPaletteNameStep({
      visible: true,
      query: 'acme-web',
      closeModal: () => {
        useAppStore.getState().closeModal()
        replaceProjectCreateRuntime()
      },
      handleOpenChange: vi.fn(),
      handleQueryChange: vi.fn(),
      setSelectedItemId: vi.fn(),
      skipRestoreFocusRef: { current: false }
    })
  )
  act(() =>
    beginProjectNameStep({
      repoId: 'repo-acme-web',
      projectLabel: 'acme-web',
      name: 'remote-fix',
      workspaceTarget: {
        projectId: 'project-web',
        hostId: 'runtime:server-a',
        projectHostSetupId: 'setup-remote'
      }
    })
  )
  await act(async () =>
    nameStep.result.current.handleKeyDown(keyEvent({ metaKey: false, ctrlKey: false }))
  )
  const waiting = mountWaitingComposer()
  waiting.rerender(false)
  await act(async () => {})

  expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  expect(useAppStore.getState().modalData).not.toHaveProperty('autoSubmit')
})

// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { ComposerModalData } from './composer-modal-data'
import type { WorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import { useComposerAutoSubmit } from './use-composer-auto-submit'

const initialAppState = useAppStore.getInitialState()

type Props = {
  createDisabled: boolean
  create?: () => Promise<void>
  repo?: string
  workspaceTarget?: WorkspaceCreationTargetHint
}

function openAutoSubmitDialog(extra: Partial<ComposerModalData> = {}): ComposerModalData {
  const data: ComposerModalData = {
    initialRepoId: 'repo-1',
    prefilledName: 'login-fix',
    autoSubmit: true,
    ...extra
  }
  useAppStore.getState().openModal('new-workspace-composer', data)
  return data
}

function setup(data: ComposerModalData, initial: Props, create: () => Promise<void>) {
  return renderHook(
    (props: Props) =>
      useComposerAutoSubmit({
        modalData: data,
        createDisabled: props.createDisabled,
        create: props.create ?? create,
        target: {
          repoId: props.repo ?? 'repo-1',
          selectedProjectId: props.workspaceTarget?.projectId ?? null,
          selectedRepoExecutionHostId: props.workspaceTarget?.hostId ?? null,
          selectedProjectHostSetupId: props.workspaceTarget?.projectHostSetupId ?? null
        }
      }),
    { initialProps: initial }
  )
}

describe('useComposerAutoSubmit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(initialAppState, true)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState(initialAppState, true)
  })

  it('does nothing for a dialog that was opened by hand', async () => {
    const data = openAutoSubmitDialog({ autoSubmit: undefined })
    const create = vi.fn(async () => {})
    setup(data, { createDisabled: false }, create)
    // Nothing is waited for: no reveal timer runs behind a dialog that does not auto-submit.
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))

    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().modalData).toBe(data)
  })

  it('presses Create once, when the form becomes ready and not before, and leaves a closed dialog closed', async () => {
    const data = openAutoSubmitDialog()
    const create = vi.fn(async () => {
      useAppStore.getState().closeModal()
    })
    const hook = setup(data, { createDisabled: true }, create)
    await act(async () => {})
    expect(create).not.toHaveBeenCalled()

    hook.rerender({ createDisabled: false })
    await act(async () => {})
    hook.rerender({ createDisabled: false })
    await act(async () => {})

    expect(create).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeModal).toBe('none')
  })

  it('presses Create once while it is running, though the form hands over a new create function every render', async () => {
    const data = openAutoSubmitDialog()
    const calls: string[] = []
    let finish: () => void = () => {}
    const running = new Promise<void>((resolve) => {
      finish = resolve
    })
    const make = (label: string) => async () => {
      calls.push(label)
      await running
    }
    const hook = setup(data, { createDisabled: true, create: make('first') }, make('unused'))
    hook.rerender({ createDisabled: false, create: make('second') })
    await act(async () => {})
    hook.rerender({ createDisabled: false, create: make('third') })
    hook.rerender({ createDisabled: false, create: make('fourth') })
    await act(async () => {})

    expect(calls).toEqual(['second'])
    finish()
    await act(async () => {})
  })

  it('opens an ordinary dialog, without the flag, when Create leaves the dialog open', async () => {
    const data = openAutoSubmitDialog()
    const create = vi.fn(async () => {})
    setup(data, { createDisabled: false }, create)
    await act(async () => {})

    expect(create).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toEqual({
      initialRepoId: 'repo-1',
      prefilledName: 'login-fix'
    })
  })

  it('shows the dialog at once and presses nothing when the form resolved to another project than the chosen one', async () => {
    const data = openAutoSubmitDialog()
    const create = vi.fn(async () => {})
    setup(data, { createDisabled: false, repo: 'repo-fallback' }, create)
    await act(async () => {})

    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toEqual({
      initialRepoId: 'repo-1',
      prefilledName: 'login-fix'
    })
  })

  it('presses nothing when the dialog was opened without a project, whatever the form picked', async () => {
    const data = openAutoSubmitDialog({ initialRepoId: undefined })
    const create = vi.fn(async () => {})
    setup(data, { createDisabled: false, repo: 'repo-fallback' }, create)
    await act(async () => {})

    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().modalData).not.toBe(data)
  })

  it('opens an ordinary dialog when the form is still not ready after four seconds, and presses nothing', async () => {
    const data = openAutoSubmitDialog()
    const create = vi.fn(async () => {})
    setup(data, { createDisabled: true }, create)
    await act(async () => vi.advanceTimersByTimeAsync(3900))
    expect(useAppStore.getState().modalData).toBe(data)

    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(useAppStore.getState().modalData).toEqual({
      initialRepoId: 'repo-1',
      prefilledName: 'login-fix'
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('does not open an ordinary dialog because of the timeout while Create is still running', async () => {
    const data = openAutoSubmitDialog()
    let finish: () => void = () => {}
    const running = new Promise<void>((resolve) => {
      finish = resolve
    })
    const create = vi.fn(async () => {
      await running
      useAppStore.getState().closeModal()
    })
    setup(data, { createDisabled: false }, create)
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    expect(useAppStore.getState().modalData).toBe(data)

    finish()
    await act(async () => {})
    expect(useAppStore.getState().activeModal).toBe('none')
  })

  it('leaves a dialog alone that another open has replaced', async () => {
    const data = openAutoSubmitDialog()
    const create = vi.fn(async () => {})
    const hook = setup(data, { createDisabled: true }, create)
    const other: ComposerModalData = { initialRepoId: 'repo-2' }
    useAppStore.getState().openModal('new-workspace-composer', other)
    hook.rerender({ createDisabled: false })
    await act(async () => vi.advanceTimersByTimeAsync(5000))

    expect(useAppStore.getState().modalData).toBe(other)
  })

  it.each([
    { projectId: 'project-web', hostId: 'local' as const, projectHostSetupId: 'setup-remote' },
    {
      projectId: 'project-other',
      hostId: 'runtime:server-a' as const,
      projectHostSetupId: 'setup-remote'
    },
    {
      projectId: 'project-web',
      hostId: 'runtime:server-a' as const,
      projectHostSetupId: 'setup-replaced'
    }
  ])(
    'reveals the dialog instead of creating on a mismatched target $hostId/$projectId/$projectHostSetupId',
    async (workspaceTarget) => {
      const data = openAutoSubmitDialog({
        initialWorkspaceTarget: {
          projectId: 'project-web',
          hostId: 'runtime:server-a',
          projectHostSetupId: 'setup-remote'
        }
      })
      setup(data, { createDisabled: false, workspaceTarget }, async () => {
        useAppStore.getState().closeModal()
      })
      await act(async () => {})

      expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
      expect(useAppStore.getState().modalData).toEqual({
        initialRepoId: 'repo-1',
        initialWorkspaceTarget: {
          projectId: 'project-web',
          hostId: 'runtime:server-a',
          projectHostSetupId: 'setup-remote'
        },
        prefilledName: 'login-fix'
      })
    }
  )
})

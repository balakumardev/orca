import { describe, expect, it } from 'vitest'
import {
  composerAutoSubmitDialogProps,
  composerBodyKey,
  composerRecoverySnapshot,
  nextAutoSubmitStep,
  stillNeedsUser,
  withoutAutoSubmit
} from './composer-auto-submit-open'
import type { ComposerModalData } from './composer-modal-data'

describe('composerBodyKey', () => {
  it('is one shared key for every dialog opened by hand', () => {
    expect(composerBodyKey(undefined)).toBe('plain')
    expect(composerBodyKey({})).toBe('plain')
    expect(composerBodyKey({ initialRepoId: 'r' })).toBe('plain')
    expect(composerBodyKey({ autoSubmit: false })).toBe('plain')
  })

  it('is a new key for each open that auto-submits, and the same one while that open stays', () => {
    const first: ComposerModalData = { autoSubmit: true, initialRepoId: 'r' }
    const second: ComposerModalData = { autoSubmit: true, initialRepoId: 'r' }
    const firstKey = composerBodyKey(first)

    expect(firstKey).toMatch(/^auto-\d+$/)
    expect(composerBodyKey(first)).toBe(firstKey)
    expect(composerBodyKey(second)).not.toBe(firstKey)
    expect(composerBodyKey({ initialRepoId: 'r' })).not.toBe(firstKey)
  })
})

describe('withoutAutoSubmit', () => {
  it('drops the flag and keeps everything else, leaving the original data alone', () => {
    const data: ComposerModalData = {
      autoSubmit: true,
      prefilledName: 'login-fix',
      initialRepoId: 'repo-1',
      telemetrySource: 'command_palette'
    }

    expect(withoutAutoSubmit(data)).toEqual({
      prefilledName: 'login-fix',
      initialRepoId: 'repo-1',
      telemetrySource: 'command_palette'
    })
    expect('autoSubmit' in withoutAutoSubmit(data)).toBe(false)
    expect(data.autoSubmit).toBe(true)
  })
})

describe('composerAutoSubmitDialogProps', () => {
  it('leaves a dialog opened by hand a plain modal dialog, whatever the open before it did', () => {
    const hidden = composerAutoSubmitDialogProps({ autoSubmit: true, initialRepoId: 'r' })
    expect(hidden.dialog.modal).toBe(false)

    for (const byHand of [undefined, {}, { initialRepoId: 'r' }, { autoSubmit: false }]) {
      expect(composerAutoSubmitDialogProps(byHand)).toEqual({
        dialog: { modal: true },
        content: {}
      })
    }
  })

  it('mounts an auto-submitting dialog invisible, non-modal and out of reach of a stray click', () => {
    const { dialog, content } = composerAutoSubmitDialogProps({ autoSubmit: true })
    const clickElsewhere = new Event('pointerdown', { cancelable: true })
    content.onInteractOutside?.(clickElsewhere)

    expect(dialog).toEqual({ modal: false })
    expect(content.style).toEqual({ visibility: 'hidden' })
    expect(content['data-autosubmit']).toBe(true)
    expect(clickElsewhere.defaultPrevented).toBe(true)
  })
})

describe('composerRecoverySnapshot', () => {
  it('is what Reopen opens: the form as it was, and never the auto-submit flag', () => {
    const data: ComposerModalData = {
      autoSubmit: true,
      prefilledName: 'login-fix',
      initialRepoId: 'repo-1',
      telemetrySource: 'command_palette'
    }

    expect(
      composerRecoverySnapshot(data, { prefilledName: 'login-fix-2', initialBaseBranch: 'dev' })
    ).toEqual({
      prefilledName: 'login-fix-2',
      initialRepoId: 'repo-1',
      initialBaseBranch: 'dev',
      telemetrySource: 'command_palette'
    })
  })
})

describe('nextAutoSubmitStep', () => {
  const base = {
    enabled: true,
    createDisabled: false,
    projectIsChosen: true,
    started: false,
    timedOut: false
  }

  it('presses Create once, when the form is ready', () => {
    expect(nextAutoSubmitStep(base)).toBe('press')
    expect(nextAutoSubmitStep({ ...base, createDisabled: true })).toBe('idle')
    expect(nextAutoSubmitStep({ ...base, started: true })).toBe('idle')
  })

  it('shows the dialog at once, and presses nothing, when the form resolved to another project', () => {
    expect(nextAutoSubmitStep({ ...base, projectIsChosen: false })).toBe('show')
    // A form that is not ready yet waits for its project like any other; only a ready one can be wrong.
    expect(nextAutoSubmitStep({ ...base, projectIsChosen: false, createDisabled: true })).toBe(
      'idle'
    )
    expect(nextAutoSubmitStep({ ...base, projectIsChosen: false, started: true })).toBe('idle')
    expect(nextAutoSubmitStep({ ...base, projectIsChosen: false, enabled: false })).toBe('idle')
  })

  it('never acts on a dialog opened by hand', () => {
    expect(nextAutoSubmitStep({ ...base, enabled: false })).toBe('idle')
    expect(
      nextAutoSubmitStep({ ...base, enabled: false, createDisabled: true, timedOut: true })
    ).toBe('idle')
  })

  it('shows the dialog only when the form never became ready in time', () => {
    expect(nextAutoSubmitStep({ ...base, createDisabled: true, timedOut: true })).toBe('show')
    expect(nextAutoSubmitStep({ ...base, createDisabled: true, timedOut: false })).toBe('idle')
    expect(nextAutoSubmitStep({ ...base, started: true, timedOut: true })).toBe('idle')
  })
})

describe('stillNeedsUser', () => {
  const opened: ComposerModalData = { autoSubmit: true }

  it('is true only for the same open still showing the composer', () => {
    expect(
      stillNeedsUser({ activeModal: 'new-workspace-composer', modalData: opened }, opened)
    ).toBe(true)
    expect(stillNeedsUser({ activeModal: 'none', modalData: {} }, opened)).toBe(false)
    expect(
      stillNeedsUser({ activeModal: 'new-workspace-composer', modalData: { ...opened } }, opened)
    ).toBe(false)
    expect(stillNeedsUser({ activeModal: 'worktree-palette', modalData: opened }, opened)).toBe(
      false
    )
  })
})

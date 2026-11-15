import type { ComposerModalData } from './composer-modal-data'

let lastOpenId = 0
const openIds = new WeakMap<object, number>()

/**
 * Identifies one open of an auto-submitting dialog. The dialog body is keyed by it, so a second open (with or
 * without `autoSubmit`) always starts from a fresh body, and an auto-submit is never carried to another open.
 * Every dialog opened by hand shares one key, as before.
 */
export function composerBodyKey(modalData: ComposerModalData | undefined): string {
  if (modalData?.autoSubmit !== true) {
    return 'plain'
  }
  let id = openIds.get(modalData)
  if (id === undefined) {
    lastOpenId += 1
    id = lastOpenId
    openIds.set(modalData, id)
  }
  return `auto-${id}`
}

/** The same dialog data without the auto-submit flag: what a reveal, a Reopen or any recovery re-opens with. */
export function withoutAutoSubmit(modalData: ComposerModalData): ComposerModalData {
  const rest: ComposerModalData = { ...modalData }
  delete rest.autoSubmit
  return rest
}

/**
 * How an auto-submitting dialog is mounted: not modal, so it casts no overlay, blur, pointer lock or focus trap,
 * invisible, and not dismissed by a click or focus elsewhere while it works. A dialog opened by hand is untouched.
 */
export function composerAutoSubmitDialogProps(modalData: ComposerModalData | undefined): {
  dialog: { modal: boolean }
  content: {
    style?: { visibility: 'hidden' }
    'data-autosubmit'?: true
    onInteractOutside?: (event: Event) => void
  }
} {
  if (modalData?.autoSubmit !== true) {
    return { dialog: { modal: true }, content: {} }
  }
  return {
    dialog: { modal: false },
    content: {
      style: { visibility: 'hidden' },
      'data-autosubmit': true,
      onInteractOutside: (event) => event.preventDefault()
    }
  }
}

/** What the failure toast's Reopen opens: the dialog data plus the form as it was, never with the auto-submit flag. */
export function composerRecoverySnapshot<T extends object>(
  modalData: ComposerModalData,
  form: T
): ComposerModalData & T {
  return { ...withoutAutoSubmit(modalData), ...form }
}

/** A hidden dialog that is still not ready by now is shown as an ordinary one. */
export const AUTO_SUBMIT_TIMEOUT_MS = 4000

export type AutoSubmitStep = 'idle' | 'press' | 'show'

/**
 * What an auto-submitting dialog does next: press its own Create once, or show itself as an ordinary dialog.
 * It presses only when the form resolved to the project the user picked in the palette: the form falls back to
 * another ready project when the picked one cannot be used (its host is not known), and creating out of sight
 * there would put the worktree in a project nobody chose.
 */
export function nextAutoSubmitStep(state: {
  enabled: boolean
  createDisabled: boolean
  /** The form resolved to the project the dialog was opened for. */
  projectIsChosen: boolean
  started: boolean
  timedOut: boolean
}): AutoSubmitStep {
  if (!state.enabled || state.started) {
    return 'idle'
  }
  if (!state.createDisabled) {
    return state.projectIsChosen ? 'press' : 'show'
  }
  return state.timedOut ? 'show' : 'idle'
}

/** After Create returns, only the very open that pressed it, and only if still showing, needs the user. */
export function stillNeedsUser(
  live: { activeModal: string; modalData: unknown },
  openedWith: ComposerModalData
): boolean {
  return live.activeModal === 'new-workspace-composer' && live.modalData === openedWith
}

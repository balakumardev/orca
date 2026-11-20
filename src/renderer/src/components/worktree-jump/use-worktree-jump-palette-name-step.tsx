import { useCallback, useEffect, useMemo, useRef } from 'react'
import type React from 'react'
import { GitBranchPlus } from 'lucide-react'
import { toast } from 'sonner'
import type { CommandInput } from '@/components/ui/command'
import { openProjectComposer } from '@/components/cmd-j/palette-project-create-composer'
import {
  endProjectNameStep,
  getProjectNameStep,
  setProjectNameStepName,
  useProjectNameStep,
  type ProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { skipPaletteExitAnimation } from './selection/worktree-jump-palette-exit-animation'

type NameStepInput = Pick<
  WorktreeJumpPaletteController,
  | 'closeModal'
  | 'handleOpenChange'
  | 'handleQueryChange'
  | 'query'
  | 'setSelectedItemId'
  | 'skipRestoreFocusRef'
  | 'visible'
>

// Keys that would move the (hidden) list highlight or leave the field.
const LIST_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Tab']
// Keys that move the text caret in the name field; only the list must not see them.
const CARET_KEYS = ['Home', 'End']
const HIDDEN = { style: { display: 'none' } } as const

/**
 * The palette's name step: after a project is chosen the input takes the worktree name. Enter hands the project
 * and name to the New worktree dialog, which stays hidden and presses its own Create, so the default agent, the
 * setup policy and remote projects behave exactly as in the dialog. Esc or Backspace on an empty name returns to
 * the search text left behind.
 */
export function useWorktreeJumpPaletteNameStep({
  closeModal,
  handleOpenChange,
  handleQueryChange,
  query,
  setSelectedItemId,
  skipRestoreFocusRef,
  visible
}: NameStepInput): {
  step: ProjectNameStep | null
  /** Replaces the search input's value, placeholder, icon and filter button while the step is open. */
  inputProps: Partial<React.ComponentProps<typeof CommandInput>>
  /** Hides the search results and the search footer while the step is open. */
  hiddenProps: { style?: { display: 'none' } }
  /** Esc and a click outside leave the step before they close the palette. */
  handleOpenChange: (open: boolean) => void
  handleKeyDown: (event: React.KeyboardEvent) => boolean
} {
  const t = useTranslate()
  const step = useProjectNameStep()
  // Set when a Backspace press left the step: that key may still be held, and its repeats belong to nobody.
  const leftOnBackspaceRef = useRef(false)
  useEffect(() => {
    if (!visible) {
      endProjectNameStep()
    }
  }, [visible])

  const returnToSearch = useCallback((): void => {
    endProjectNameStep()
    // The search text is put back through the same path typing takes: cmdk re-highlights its first row, and the
    // folder guard keeps a folder or "New worktree" row from being armed, so a typed Enter cannot add a folder.
    handleQueryChange(query)
  }, [handleQueryChange, query])

  const submit = useCallback((): void => {
    const live = getProjectNameStep()
    const name = live?.name.trim() ?? ''
    if (!live || !name) {
      return
    }
    const repo = useAppStore.getState().repos.find((candidate) => candidate.id === live.repoId)
    if (!repo) {
      toast.error(
        translate(
          'worktreeJumpPalette.projectCreate.projectGone',
          'That project is no longer there'
        )
      )
      returnToSearch()
      return
    }
    // The step ends in the same tick, so a second Enter finds nothing to submit.
    endProjectNameStep()
    skipRestoreFocusRef.current = true
    skipPaletteExitAnimation()
    closeModal()
    setSelectedItemId('')
    openProjectComposer(repo.id, name, true)
  }, [closeModal, returnToSearch, setSelectedItemId, skipRestoreFocusRef])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      // keyCode 229 marks a key the input method is handling, even where isComposing is already false.
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        return false
      }
      const consume = (): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      // A Backspace held through the exit must not go on to eat the search text that was put back.
      const heldThroughExit =
        event.key === 'Backspace' && event.repeat && leftOnBackspaceRef.current
      if (!(event.key === 'Backspace' && event.repeat)) {
        leftOnBackspaceRef.current = false
      }
      if (heldThroughExit) {
        consume()
        return true
      }
      const live = getProjectNameStep()
      if (!live) {
        return false
      }
      if (event.key === 'Enter') {
        consume()
        // A held key repeats Enter; only the first press may create.
        if (!event.repeat && !event.metaKey && !event.ctrlKey) {
          submit()
        }
        return true
      }
      if (event.key === 'Escape') {
        consume()
        returnToSearch()
        return true
      }
      if (event.key === 'Backspace' && live.name === '') {
        consume()
        // A held Backspace that has just emptied the name must not go on to eat the search text.
        if (!event.repeat) {
          leftOnBackspaceRef.current = true
          returnToSearch()
        }
        return true
      }
      if (LIST_KEYS.includes(event.key)) {
        consume()
        return true
      }
      if (CARET_KEYS.includes(event.key)) {
        event.stopPropagation()
        return true
      }
      return false
    },
    [returnToSearch, submit]
  )

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open && getProjectNameStep()) {
        returnToSearch()
        return
      }
      handleOpenChange(open)
    },
    [handleOpenChange, returnToSearch]
  )

  const inputProps = useMemo(
    () =>
      step
        ? {
            value: step.name,
            onValueChange: setProjectNameStepName,
            placeholder: t(
              'worktreeJumpPalette.projectCreate.namePlaceholder',
              'New worktree in {{value0}} - type a name',
              { value0: step.projectLabel }
            ),
            icon: <GitBranchPlus className="mr-2.5 h-4 w-4 shrink-0 text-muted-foreground/60" />,
            trailing: null
          }
        : {},
    [step, t]
  )
  return {
    step,
    inputProps,
    hiddenProps: step ? HIDDEN : {},
    handleOpenChange: onOpenChange,
    handleKeyDown
  }
}

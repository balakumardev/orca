import { useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store/index'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { globalShortcutTargetYields } from '@/lib/plugins/commands/plugin-command-keybindings'
import { keybindingMatchesAction, type KeybindingActionId } from '../../../../shared/keybindings'
import { cycleActivityThread, type ActivityCycleDirection } from './activity-thread-cycle'
import {
  findActivityThreadItemIndex,
  getActivityVirtualItemThreads,
  type ActivityVirtualItemDescriptor
} from './thread-list/activity-thread-virtual-items'
import type { ActivityThreadClickEvent } from './thread-list/use-activity-thread-selection'
import type { AgentPaneThread } from './threads/activity-thread-types'

const CYCLE_ACTIONS: readonly (readonly [KeybindingActionId, ActivityCycleDirection])[] = [
  ['sidebar.activity.previousAgent', 'previous'],
  ['sidebar.activity.nextAgent', 'next']
]

// A shortcut activation must behave like a plain click, which also replaces any multi-selection.
const PLAIN_CLICK: ActivityThreadClickEvent = { metaKey: false, ctrlKey: false, shiftKey: false }

type CycleTarget = {
  virtualItems: readonly ActivityVirtualItemDescriptor[]
  selectedPaneKey: string | null
  onActivate: (thread: AgentPaneThread, event: ActivityThreadClickEvent) => void
  virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, 'scrollToIndex'>
}

/** Previous/next agent chords over the rows the Activity list renders; enable only where that list is displayed. */
export function useActivityAgentCycleShortcut({
  enabled,
  ...target
}: CycleTarget & { enabled: boolean }): void {
  // Read through a ref so status pings, which rebuild the rows, do not re-register the listener.
  const targetRef = useRef<CycleTarget>(target)
  useEffect(() => {
    targetRef.current = target
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.key === 'Process' ||
        event.getModifierState('AltGraph')
      ) {
        return
      }
      const { activeModal, keybindings, settings } = useAppStore.getState()
      const platform = getShortcutPlatform()
      const matchOptions = {
        context:
          event.target instanceof HTMLElement &&
          event.target.classList.contains('xterm-helper-textarea')
            ? ('terminal' as const)
            : ('app' as const),
        terminalShortcutPolicy: settings?.terminalShortcutPolicy
      }
      const matched = CYCLE_ACTIONS.find(([actionId]) =>
        keybindingMatchesAction(actionId, event, platform, keybindings, matchOptions)
      )
      if (
        !matched ||
        globalShortcutTargetYields(event, platform, keybindings, matchOptions, matched[0]) ||
        activeModal !== 'none' ||
        hasVisibleOverlay()
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const { virtualItems, selectedPaneKey, onActivate, virtualizer } = targetRef.current
      const thread = cycleActivityThread(
        getActivityVirtualItemThreads(virtualItems),
        selectedPaneKey,
        matched[1]
      )
      if (!thread) {
        return
      }
      onActivate(thread, PLAIN_CLICK)
      // Selecting leaves the rows unchanged, so the index is valid now; an effect keyed on selection would also fire on status-driven reorders.
      const index = findActivityThreadItemIndex(virtualItems, thread.paneKey)
      if (index !== null) {
        virtualizer.scrollToIndex(index, { align: 'auto' })
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [enabled])
}

import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  type KeybindingActionId
} from './keybindings'

const PLATFORMS = ['darwin', 'linux', 'win32'] as const

const CHORDS: readonly {
  actionId: KeybindingActionId
  binding: string
  key: string
  code: string
}[] = [
  {
    actionId: 'sidebar.activity.previousAgent',
    binding: 'Mod+Shift+Semicolon',
    key: ':',
    code: 'Semicolon'
  },
  { actionId: 'sidebar.activity.nextAgent', binding: 'Mod+Shift+Quote', key: '"', code: 'Quote' },
  { actionId: 'sidebar.activity.toggle', binding: 'Mod+Shift+L', key: 'L', code: 'KeyL' }
]

describe('Activity sidebar shortcuts', () => {
  it.each(PLATFORMS)('ships the same default chords on %s without conflicts', (platform) => {
    for (const { actionId, binding } of CHORDS) {
      expect(getEffectiveKeybindingsForAction(actionId, platform)).toEqual([binding])
    }
    expect(findKeybindingConflicts(platform, {}, { includeMainProcessInterception: true })).toEqual(
      []
    )
  })

  it.each(PLATFORMS)(
    'matches the physical key presses on %s, even when terminal-first',
    (platform) => {
      const primary =
        platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
      for (const { actionId, key, code } of CHORDS) {
        const input = { key, code, alt: false, shift: true, ...primary }
        expect(
          keybindingMatchesAction(actionId, input, platform, undefined, {
            context: 'terminal',
            terminalShortcutPolicy: 'terminal-first'
          })
        ).toBe(true)
      }
    }
  )

  it('honors a user override instead of the default chord', () => {
    const overrides = { 'sidebar.activity.toggle': ['Mod+Alt+L'] }
    expect(
      getEffectiveKeybindingsForAction('sidebar.activity.toggle', 'darwin', overrides)
    ).toEqual(['Mod+Alt+L'])
    expect(
      keybindingMatchesAction(
        'sidebar.activity.toggle',
        { key: 'L', code: 'KeyL', meta: true, shift: true },
        'darwin',
        overrides
      )
    ).toBe(false)
  })
})

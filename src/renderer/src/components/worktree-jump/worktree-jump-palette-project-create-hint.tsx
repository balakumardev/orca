import type React from 'react'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'

/**
 * The footer hints of the two chords that start a worktree name. Each names the project it would act on, since
 * the highlighted row is chosen by the search and the user must see the target before pressing. The labels are
 * full-strength muted text: this footer is where the chord is learned.
 */
export function WorktreeJumpPaletteProjectCreateHint({
  modKey,
  rowProjectLabel,
  currentProjectLabel,
  folderAddsProject = false
}: {
  modKey: string
  /** The project of the highlighted row, when it has one a worktree can be started in. */
  rowProjectLabel: string | null
  /** The project of the workspace you are in, when it is not the one already named for the row. */
  currentProjectLabel: string | null
  /** The highlighted row is a git folder that is not a project yet: the chord adds it, then starts the name. */
  folderAddsProject?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {folderAddsProject ? (
        <>
          <ShortcutKeyCombo keys={[modKey, 'Enter']} />
          <span className="max-w-[16rem] truncate text-2xs text-muted-foreground">
            {t('worktreeJumpPalette.projectCreate.addAndCreate', 'Add + new worktree')}
          </span>
        </>
      ) : null}
      {rowProjectLabel ? (
        <>
          <ShortcutKeyCombo keys={[modKey, 'Enter']} />
          <span className="max-w-[16rem] truncate text-2xs text-muted-foreground">
            {t('worktreeJumpPalette.projectCreate.footerHint', 'New worktree in {{value0}}', {
              value0: rowProjectLabel
            })}
          </span>
        </>
      ) : null}
      {currentProjectLabel ? (
        <>
          <ShortcutKeyCombo keys={[modKey, 'Shift', 'Enter']} />
          <span className="max-w-[16rem] truncate text-2xs text-muted-foreground">
            {t('worktreeJumpPalette.projectCreate.currentHint', 'New worktree in {{value0}}', {
              value0: currentProjectLabel
            })}
          </span>
        </>
      ) : null}
    </>
  )
}

import type React from 'react'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  getPaletteEntryFolderNewWorktree,
  getPaletteEntryNewWorktreeRepoId
} from './worktree-jump-palette-entry-project'

type ChipRowProps = {
  entry: PaletteListEntry
  renderKey: string
  controller: WorktreeJumpPaletteController
}

/**
 * The key hint on the highlighted row. On a worktree or project row it sits at the free end of the title line; on
 * a workspace-tab row it is the first item of the right-hand meta box, so that box can take width from the
 * secondary text beside it while the row is highlighted. It is the first thing to give way when a line is short
 * (the title keeps what it had), it is hidden below the `sm` breakpoint like the Sessions excerpt, and it adds no
 * height (the keycaps are smaller than the title line).
 */
function NewWorktreeChip({ label }: { label: string }): React.JSX.Element {
  const modKey = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
  return (
    <span
      aria-hidden="true"
      data-slot="palette-new-worktree-chip"
      className="ml-auto flex min-w-0 shrink-[1000] items-center gap-1.5 overflow-hidden whitespace-nowrap max-sm:hidden"
    >
      <ShortcutKeyCombo
        keys={[modKey, 'Enter']}
        className="shrink-0 gap-0.5"
        keyCapClassName="min-w-4 border-border/60 bg-background/45 px-1 py-px text-3xs text-muted-foreground shadow-none"
        separatorClassName="text-3xs text-muted-foreground/60"
      />
      <span className="min-w-0 truncate text-2xs text-muted-foreground">{label}</span>
    </span>
  )
}

/**
 * "Cmd+Enter New worktree" on the highlighted worktree, workspace-tab or project row. It shows exactly when the
 * chord would act: the row is the one the shortcut reads, and its project is one a worktree can be started in.
 */
export function WorktreeJumpPaletteProjectChip({
  entry,
  renderKey,
  controller
}: ChipRowProps): React.JSX.Element | null {
  const t = useTranslate()
  const { commandSelectedItemId, repos, taskSourceUrl, workspaces } = controller
  if (
    commandSelectedItemId !== renderKey ||
    !getPaletteEntryNewWorktreeRepoId(entry, { workspaces, repos, taskSourceUrl })
  ) {
    return null
  }
  return (
    <NewWorktreeChip label={t('worktreeJumpPalette.projectCreate.chipLabel', 'New worktree')} />
  )
}

/** "Cmd+Enter Add + new worktree" on the highlighted Folders row that is an untracked git root. */
export function WorktreeJumpPaletteFolderAddChip({
  entry,
  renderKey,
  controller
}: ChipRowProps): React.JSX.Element | null {
  const t = useTranslate()
  if (
    controller.commandSelectedItemId !== renderKey ||
    !getPaletteEntryFolderNewWorktree(entry, controller.taskSourceUrl)
  ) {
    return null
  }
  return (
    <NewWorktreeChip
      label={t('worktreeJumpPalette.projectCreate.addAndCreate', 'Add + new worktree')}
    />
  )
}

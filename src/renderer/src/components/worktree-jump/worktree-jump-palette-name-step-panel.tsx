import type React from 'react'
import type { ProjectNameStep } from '@/components/cmd-j/palette-project-name-step-store'
import { useTranslate } from '@/i18n/use-translate'
import { FooterKey, PaletteHostBadgeChip } from './worktree-jump-palette-primitives'

/** What the palette shows under the input while a worktree name is being typed. */
export function WorktreeJumpPaletteNameStepPanel({
  step
}: {
  step: ProjectNameStep
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <div data-slot="palette-project-name-step" className="px-4 pb-4 pt-3">
        <div className="truncate text-sm font-medium text-foreground">
          {t('worktreeJumpPalette.projectCreate.rowTitle', 'New worktree in {{value0}}', {
            value0: step.projectLabel
          })}
        </div>
        {/* The chosen host distinguishes otherwise identical project paths. */}
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground/82">
          <PaletteHostBadgeChip
            badge={
              step.host && step.host.executionHostId !== 'local'
                ? { hostId: step.host.executionHostId, label: step.host.label }
                : null
            }
          />
          <span className="truncate">{step.projectPath}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground/82">
          {t(
            'worktreeJumpPalette.projectCreate.nameNote',
            'Same as Create in the New worktree dialog.'
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <FooterKey>{t('auto.components.WorktreeJumpPalette.f65d992a11', 'Enter')}</FooterKey>
        <span>{t('worktreeJumpPalette.projectCreate.nameCreate', 'Create worktree')}</span>
        <FooterKey>{t('auto.components.WorktreeJumpPalette.66b5a67bee', 'Esc')}</FooterKey>
        <span>{t('worktreeJumpPalette.projectCreate.nameBack', 'Back')}</span>
      </div>
    </>
  )
}

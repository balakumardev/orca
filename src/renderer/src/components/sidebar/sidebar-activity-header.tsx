import React, { useId } from 'react'
import { Bell, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

type SidebarActivityHeaderProps = {
  open: boolean
  onToggle: () => void
  badgeTarget?: React.Ref<HTMLSpanElement>
  optionsTarget?: React.Ref<HTMLDivElement>
}

/** Always-visible title row of the Activity pane; it hosts the attention badge and the options menu portals. */
export function SidebarActivityHeader({
  open,
  onToggle,
  badgeTarget,
  optionsTarget
}: SidebarActivityHeaderProps): React.JSX.Element {
  const t = useTranslate()
  // Subscribe to locale changes: this row sits behind a memo boundary in the sidebar.
  useTranslation()
  const badgeId = useId()
  const label = open
    ? t('auto.components.sidebar.SidebarActivityHeader.collapse', 'Collapse Activity')
    : t('auto.components.sidebar.SidebarActivityHeader.expand', 'Expand Activity')

  return (
    <div
      className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-1.5 px-2"
      data-sidebar-activity-header=""
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={badgeId}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pl-1.5 pr-1 text-left text-xs font-semibold text-muted-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn('size-3 shrink-0 transition-transform', !open && '-rotate-90')}
        />
        <span className="min-w-0 truncate select-none">
          {t('auto.components.sidebar.SidebarActivityHeader.title', 'Activity')}
        </span>
        <span className="relative h-5 w-6 shrink-0">
          <Bell className="absolute left-0 top-1 size-3" />
          <span id={badgeId} ref={badgeTarget} className="pointer-events-none absolute inset-0" />
        </span>
      </button>
      <div ref={optionsTarget} className="flex size-6 shrink-0 items-center" />
    </div>
  )
}

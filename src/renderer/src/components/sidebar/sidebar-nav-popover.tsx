import React, { useMemo, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { useAgentBucketCounts } from '@/components/dashboard/bucket-counts/useAgentBucketCounts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { resolveLeftSidebarStyleVariables } from '@/app-shell/appearance/left-sidebar-appearance'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import SidebarNav, { shouldShowAgentDashboardButton } from './SidebarNav'

function AgentDashboardDot(): React.JSX.Element | null {
  const counts = useAgentBucketCounts()
  if (counts.attention > 0) {
    return <AgentQuestionIcon className="absolute right-0.5 top-0.5 size-2" />
  }
  return counts.working > 0 ? (
    <span className="absolute right-1 top-1 size-1.5 rounded-full bg-(--status-warning)" />
  ) : null
}

/** Titlebar button beside the sidebar toggle; the Search, Tasks, Skills and similar rows open as a floating popover. */
export function SidebarNavPopoverButton(): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const [open, setOpen] = useState(false)
  const settings = useAppStore((s) => s.settings)
  const showDashboardDot = shouldShowAgentDashboardButton(settings)
  const sidebarStyle = useMemo(() => resolveLeftSidebarStyleVariables(settings), [settings])
  const label = t('auto.components.sidebar.SidebarNavPopover.label', 'Quick links')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="sidebar-toggle relative"
              aria-label={label}
              data-sidebar-nav-popover-trigger=""
            >
              <LayoutGrid size={15} />
              {showDashboardDot ? <AgentDashboardDot /> : null}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-64 border-worktree-sidebar-border bg-worktree-sidebar p-0 text-worktree-sidebar-foreground"
        style={sidebarStyle}
        data-sidebar-nav-popover=""
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Row context menus render in their own portal; a click there must not dismiss the popover.
        onInteractOutside={(event) => {
          if (event.target instanceof Element && event.target.closest('[role="menu"]')) {
            event.preventDefault()
          }
        }}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('button')) {
            setOpen(false)
          }
        }}
      >
        <SidebarNav />
      </PopoverContent>
    </Popover>
  )
}

import React from 'react'
import { ListTodo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  getProjectTodoScopeKeyFromHeader,
  getProjectTodoSectionOccurrenceKey
} from '../../../../../shared/project-todos-types'
import type { GroupHeaderRow, WorktreeGroupBy } from '../../../../../shared/sidebar-list/row-types'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from '../worktree-list/rows/header-event-guards'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../worktree-list/rows/repo-header-action-button-class'
import { EMPTY_PROJECT_TODO_ITEMS, useProjectTodosStore } from './project-todos-store'

function useProjectHeaderTodoSummary(
  row: GroupHeaderRow,
  groupBy: WorktreeGroupBy
): {
  projectKey: string | null
  sectionKey: string
  openCount: number
  isExpanded: boolean
} {
  const projectKey = getProjectTodoScopeKeyFromHeader(row, groupBy)
  const sectionKey = getProjectTodoSectionOccurrenceKey(row)
  const openCount = useProjectTodosStore((state) => {
    if (!projectKey) {
      return 0
    }
    const items = state.projects[projectKey] ?? EMPTY_PROJECT_TODO_ITEMS
    let count = 0
    for (const item of items) {
      if (!item.done) {
        count += 1
      }
    }
    return count
  })
  const isExpanded = useProjectTodosStore((state) =>
    projectKey ? state.expandedSectionKeys.has(sectionKey) : false
  )
  return { projectKey, sectionKey, openCount, isExpanded }
}

export const ProjectTodoHeaderBadge = React.memo(function ProjectTodoHeaderBadge({
  row,
  groupBy
}: {
  row: GroupHeaderRow
  groupBy: WorktreeGroupBy
}): React.JSX.Element | null {
  const t = useTranslate()
  const { projectKey, sectionKey, openCount, isExpanded } = useProjectHeaderTodoSummary(
    row,
    groupBy
  )
  if (!projectKey || (openCount === 0 && !isExpanded)) {
    return null
  }
  const label =
    openCount > 0
      ? t('auto.components.sidebar.projectTodos.openCountBadge', '{{value0}} open TODOs', {
          value0: openCount
        })
      : t('auto.components.sidebar.projectTodos.hideTodos', 'Hide project TODOs')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-repo-header-action=""
          data-testid="project-todo-header-badge"
          aria-expanded={isExpanded}
          aria-label={label}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            useProjectTodosStore
              .getState()
              .toggleTodoSection(sectionKey, { focusInput: !isExpanded })
          }}
          className={cn(
            'inline-flex h-4 shrink-0 items-center gap-1 rounded px-1 text-2xs font-medium tabular-nums transition-colors',
            isExpanded
              ? 'bg-accent text-foreground ring-1 ring-border/70'
              : 'bg-worktree-sidebar-accent/80 text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <ListTodo className="size-2.5 shrink-0" />
          {openCount > 0 ? <span>{openCount}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
})

export const ProjectTodoHeaderActionButton = React.memo(function ProjectTodoHeaderActionButton({
  row,
  groupBy
}: {
  row: GroupHeaderRow
  groupBy: WorktreeGroupBy
}): React.JSX.Element | null {
  const t = useTranslate()
  const { projectKey, sectionKey, openCount, isExpanded } = useProjectHeaderTodoSummary(
    row,
    groupBy
  )
  if (!projectKey || openCount > 0 || isExpanded) {
    return null
  }
  const label = t('auto.components.sidebar.projectTodos.addProjectTodo', 'Project TODOs')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={REPO_HEADER_ACTION_BUTTON_CLASS}
          data-repo-header-action=""
          data-testid="project-todo-header-action"
          aria-label={label}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            useProjectTodosStore.getState().openTodoSection(sectionKey, { focusInput: true })
          }}
        >
          <ListTodo className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
})

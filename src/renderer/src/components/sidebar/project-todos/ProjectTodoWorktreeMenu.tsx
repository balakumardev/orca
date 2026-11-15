import React from 'react'
import { Check, FolderPlus, GitBranch, GitBranchPlus, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ProjectTodoItem } from '../../../../../shared/project-todos-types'
import type { GroupHeaderRow } from '../../../../../shared/sidebar-list/row-types'
import {
  startWorktreeFromProjectTodo,
  useProjectAvailableWorktrees
} from './project-todo-worktree-actions'
import { useProjectTodosStore } from './project-todos-store'

export function ProjectTodoWorktreeMenu({
  headerRow,
  projectKey,
  todo
}: {
  headerRow: GroupHeaderRow
  projectKey: string
  todo: ProjectTodoItem
}): React.JSX.Element {
  const t = useTranslate()
  const availableWorktrees = useProjectAvailableWorktrees(headerRow)
  const isFolderProject = Boolean(!headerRow.repo && headerRow.projectGroup)
  const startLabel = isFolderProject
    ? t('auto.components.sidebar.projectTodos.startNewWorkspace', 'Start new workspace…')
    : t('auto.components.sidebar.projectTodos.startNewWorktree', 'Start new worktree…')
  const triggerLabel = todo.worktree
    ? t('auto.components.sidebar.projectTodos.changeWorktree', 'Change linked worktree')
    : t('auto.components.sidebar.projectTodos.assignOrStartWorktree', 'Assign or start worktree')

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="project-todo-worktree-menu-trigger"
              aria-label={triggerLabel}
              className="size-5 shrink-0 rounded text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              <GitBranch className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {triggerLabel}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          onSelect={() => {
            startWorktreeFromProjectTodo({ headerRow, projectKey, todo })
          }}
        >
          {isFolderProject ? (
            <FolderPlus className="size-3.5 text-muted-foreground" />
          ) : (
            <GitBranchPlus className="size-3.5 text-muted-foreground" />
          )}
          <span>{startLabel}</span>
        </DropdownMenuItem>

        {availableWorktrees.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="py-1 text-2xs font-medium text-muted-foreground">
              {t('auto.components.sidebar.projectTodos.linkExisting', 'Link existing')}
            </DropdownMenuLabel>
            {availableWorktrees.map((option) => {
              const isSelected =
                todo.worktree?.worktreeId === option.worktreeId &&
                (todo.worktree.hostId ?? null) === (option.hostId ?? null)
              return (
                <DropdownMenuItem
                  key={`${option.hostId ?? 'local'}:${option.worktreeId}`}
                  onSelect={() => {
                    useProjectTodosStore.getState().assignTodoWorktree(projectKey, todo.id, {
                      worktreeId: option.worktreeId,
                      hostId: option.hostId,
                      displayName: option.displayName
                    })
                  }}
                >
                  <Check
                    className={cn('size-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.displayName}</span>
                  {option.branchLabel ? (
                    <span className="max-w-20 shrink-0 truncate text-2xs text-muted-foreground">
                      {option.branchLabel}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </>
        ) : null}

        {todo.worktree ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                useProjectTodosStore.getState().assignTodoWorktree(projectKey, todo.id, null)
              }}
            >
              <Unlink className="size-3.5 text-muted-foreground" />
              <span>
                {t('auto.components.sidebar.projectTodos.unlinkWorktree', 'Unlink worktree')}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

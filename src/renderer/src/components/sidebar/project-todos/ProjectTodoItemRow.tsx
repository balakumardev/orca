import React, { useEffect, useRef, useState } from 'react'
import { GitBranch, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import {
  PROJECT_TODO_MAX_TEXT_LENGTH,
  type ProjectTodoItem
} from '../../../../../shared/project-todos-types'
import type { GroupHeaderRow } from '../../../../../shared/sidebar-list/row-types'
import { ProjectTodoWorktreeMenu } from './ProjectTodoWorktreeMenu'
import { activateProjectTodoWorktree } from './project-todo-worktree-actions'
import { useProjectTodosStore } from './project-todos-store'

export function ProjectTodoItemRow({
  headerRow,
  projectKey,
  todo
}: {
  headerRow: GroupHeaderRow
  projectKey: string
  todo: ProjectTodoItem
}): React.JSX.Element {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(todo.text)
  const editInputRef = useRef<HTMLInputElement>(null)

  const isCreatingWorktree = useProjectTodosStore((state) =>
    Object.values(state.pendingCreationById).some(
      (link) => link.projectKey === projectKey && link.todoId === todo.id
    )
  )

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [editing])

  const commitEdit = (): void => {
    const trimmed = draftText.trim()
    if (trimmed && trimmed !== todo.text) {
      useProjectTodosStore.getState().updateTodoText(projectKey, todo.id, trimmed)
    } else {
      setDraftText(todo.text)
    }
    setEditing(false)
  }

  return (
    <div
      data-testid="project-todo-item-row"
      className="group/todo flex min-h-6 items-start gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-worktree-sidebar-accent/60"
    >
      <Checkbox
        checked={todo.done}
        onCheckedChange={() => {
          useProjectTodosStore.getState().toggleTodoDone(projectKey, todo.id)
        }}
        aria-label={t('auto.components.sidebar.projectTodos.markTodo', 'Toggle {{value0}}', {
          value0: todo.text
        })}
        className="mt-0.5 size-3.5 rounded-[3px]"
      />

      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={editInputRef}
            type="text"
            value={draftText}
            maxLength={PROJECT_TODO_MAX_TEXT_LENGTH}
            onChange={(event) => setDraftText(event.target.value)}
            onBlur={commitEdit}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (isImeOwnedKeyboardEvent(event)) {
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                commitEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setDraftText(todo.text)
                setEditing(false)
              }
            }}
            className="w-full rounded bg-background px-1 py-0 text-xs leading-4 text-foreground ring-1 ring-ring outline-none"
          />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span
              onDoubleClick={() => {
                setDraftText(todo.text)
                setEditing(true)
              }}
              title={t(
                'auto.components.sidebar.projectTodos.doubleClickEdit',
                'Double-click to edit'
              )}
              className={cn(
                'min-w-0 break-words text-xs leading-4 select-none',
                todo.done ? 'text-muted-foreground line-through' : 'text-sidebar-foreground'
              )}
            >
              {todo.text}
            </span>

            {isCreatingWorktree ? (
              <span className="inline-flex max-w-full items-center gap-1 rounded bg-worktree-sidebar-accent px-1.5 py-px text-2xs text-muted-foreground">
                <Loader2 className="size-2.5 shrink-0 animate-spin" />
                <span className="truncate">
                  {t('auto.components.sidebar.projectTodos.creatingBadge', 'Creating…')}
                </span>
              </span>
            ) : todo.worktree ? (
              todo.done ? (
                <span className="inline-flex max-w-full items-center gap-1 rounded bg-worktree-sidebar-accent/60 px-1.5 py-px text-2xs text-muted-foreground/80">
                  <GitBranch className="size-2.5 shrink-0" />
                  <span className="truncate">{todo.worktree.displayName}</span>
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="project-todo-worktree-pill"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (todo.worktree) {
                          activateProjectTodoWorktree(todo.worktree)
                        }
                      }}
                      className="inline-flex max-w-full items-center gap-1 rounded bg-worktree-sidebar-accent px-1.5 py-px text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <GitBranch className="size-2.5 shrink-0" />
                      <span className="truncate">{todo.worktree.displayName}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {t(
                      'auto.components.sidebar.projectTodos.switchToWorktree',
                      'Switch to {{value0}}',
                      { value0: todo.worktree.displayName }
                    )}
                  </TooltipContent>
                </Tooltip>
              )
            ) : null}
          </div>
        )}
      </div>

      {!editing ? (
        <div className="flex shrink-0 items-center gap-0.5 transition-opacity can-hover:opacity-0 group-hover/todo:opacity-100 focus-within:opacity-100 has-[button[aria-expanded=true]]:opacity-100">
          {!todo.done ? (
            <ProjectTodoWorktreeMenu headerRow={headerRow} projectKey={projectKey} todo={todo} />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="project-todo-delete-button"
                aria-label={t('auto.components.sidebar.projectTodos.deleteTodo', 'Delete TODO')}
                onClick={(event) => {
                  event.stopPropagation()
                  useProjectTodosStore.getState().deleteTodo(projectKey, todo.id)
                }}
                className="size-5 shrink-0 rounded text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              >
                <X className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.sidebar.projectTodos.deleteTodo', 'Delete TODO')}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}

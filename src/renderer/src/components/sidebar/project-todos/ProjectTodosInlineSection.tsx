import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import {
  PROJECT_TODO_MAX_TEXT_LENGTH,
  getProjectTodoScopeKeyFromHeader
} from '../../../../../shared/project-todos-types'
import type { GroupHeaderRow } from '../../../../../shared/sidebar-list/row-types'
import { getWorktreeCardSurfaceInset } from '../worktree-list/rows/indentation'
import { ProjectTodoItemRow } from './ProjectTodoItemRow'
import { EMPTY_PROJECT_TODO_ITEMS, useProjectTodosStore } from './project-todos-store'

export function ProjectTodosInlineSection({
  headerRow,
  sectionKey
}: {
  headerRow: GroupHeaderRow
  sectionKey: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const projectKey = getProjectTodoScopeKeyFromHeader(headerRow, 'repo')
  const items = useProjectTodosStore((state) =>
    projectKey ? (state.projects[projectKey] ?? EMPTY_PROJECT_TODO_ITEMS) : EMPTY_PROJECT_TODO_ITEMS
  )
  const doneExpanded = useProjectTodosStore((state) =>
    state.doneExpandedSectionKeys.has(sectionKey)
  )
  const shouldFocusInput = useProjectTodosStore(
    (state) => state.focusInputSectionKey === sectionKey
  )

  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!shouldFocusInput) {
      return
    }
    if (useProjectTodosStore.getState().consumeFocusInputRequest(sectionKey)) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [sectionKey, shouldFocusInput])

  const { openTodos, doneTodos } = useMemo(() => {
    const open = items.filter((item) => !item.done)
    const done = items.filter((item) => item.done)
    return { openTodos: open, doneTodos: done }
  }, [items])

  if (!projectKey) {
    return null
  }

  const surfaceInset = getWorktreeCardSurfaceInset({
    isGrouped: true,
    groupDepth: headerRow.projectGroupDepth ?? 0
  })

  const submitDraft = (): void => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }
    useProjectTodosStore.getState().addTodo(projectKey, trimmed)
    setDraft('')
    inputRef.current?.focus()
  }

  return (
    <div
      data-testid="project-todos-inline-section"
      style={{ marginLeft: `${surfaceInset + 6}px` }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="mr-2 mb-1.5 rounded-md border border-worktree-sidebar-border/80 bg-worktree-sidebar-accent/25 px-1.5 py-1"
    >
      <div className="flex items-center gap-1 px-1 py-0.5">
        <Plus className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          data-testid="project-todos-quick-input"
          value={draft}
          maxLength={PROJECT_TODO_MAX_TEXT_LENGTH}
          placeholder={t(
            'auto.components.sidebar.projectTodos.quickAddPlaceholder',
            'Jot a quick idea or task…'
          )}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (isImeOwnedKeyboardEvent(event)) {
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              submitDraft()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              if (draft.length > 0) {
                setDraft('')
              } else {
                useProjectTodosStore.getState().closeTodoSection(sectionKey)
              }
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-xs leading-4 text-foreground placeholder:text-muted-foreground/75 outline-none"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('auto.components.sidebar.projectTodos.closePanel', 'Close project TODOs')}
          onClick={() => useProjectTodosStore.getState().closeTodoSection(sectionKey)}
          className="size-4 shrink-0 rounded text-muted-foreground hover:bg-accent/80 hover:text-foreground"
        >
          <X className="size-3" />
        </Button>
      </div>

      {openTodos.length > 0 ? (
        <div className="mt-0.5 flex flex-col gap-px border-t border-worktree-sidebar-border/60 pt-1">
          {openTodos.map((todo) => (
            <ProjectTodoItemRow
              key={todo.id}
              headerRow={headerRow}
              projectKey={projectKey}
              todo={todo}
            />
          ))}
        </div>
      ) : null}

      {doneTodos.length > 0 ? (
        <div className="mt-1 border-t border-worktree-sidebar-border/60 pt-1">
          <div className="flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              data-testid="project-todos-done-toggle"
              aria-expanded={doneExpanded}
              onClick={() => useProjectTodosStore.getState().toggleDoneSection(sectionKey)}
              className="inline-flex items-center gap-1 rounded py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', doneExpanded && 'rotate-90')}
              />
              <span>
                {t('auto.components.sidebar.projectTodos.doneCount', 'Done ({{value0}})', {
                  value0: doneTodos.length
                })}
              </span>
            </button>

            <button
              type="button"
              data-testid="project-todos-clear-done"
              onClick={() => useProjectTodosStore.getState().clearCompletedTodos(projectKey)}
              className="rounded px-1 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            >
              {t('auto.components.sidebar.projectTodos.clearDone', 'Clear done')}
            </button>
          </div>

          {doneExpanded ? (
            <div className="mt-0.5 flex flex-col gap-px">
              {doneTodos.map((todo) => (
                <ProjectTodoItemRow
                  key={todo.id}
                  headerRow={headerRow}
                  projectKey={projectKey}
                  todo={todo}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

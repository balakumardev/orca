// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../shared/repo-types'
import type { GroupHeaderRow } from '../../../../../shared/sidebar-list/row-types'
import { ProjectTodoHeaderBadge } from './ProjectTodoHeaderControls'
import { ProjectTodosInlineSection } from './ProjectTodosInlineSection'
import { useProjectTodosStore } from './project-todos-store'

const repo: Repo = {
  id: 'orca',
  path: '/workspace/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const headerRow: GroupHeaderRow = {
  type: 'header',
  key: 'repo:orca',
  collapseKey: 'repo:orca',
  label: 'orca',
  count: 1,
  icon: { kind: 'project' },
  repo
}

describe('ProjectTodosInlineSection UI', () => {
  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState(useAppStore.getInitialState(), true)
    useProjectTodosStore.setState(useProjectTodosStore.getInitialState(), true)
    useProjectTodosStore.getState().openTodoSection('repo:orca')
  })

  afterEach(() => {
    cleanup()
  })

  it('jots quick ideas on Enter, updates header badge count, toggles Done (N), and clears completed items', () => {
    const view = render(
      <TooltipProvider>
        <div>
          <ProjectTodoHeaderBadge row={headerRow} groupBy="repo" />
          <ProjectTodosInlineSection headerRow={headerRow} sectionKey="repo:orca" />
        </div>
      </TooltipProvider>
    )

    const input = view.getByTestId('project-todos-quick-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'First quick idea' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: 'Second quick idea' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(view.getByTestId('project-todo-header-badge').textContent).toBe('2')
    expect(view.getAllByTestId('project-todo-item-row')).toHaveLength(2)

    // Complete one TODO via its checkbox.
    const checkboxes = view.container.querySelectorAll<HTMLButtonElement>('[data-slot="checkbox"]')
    fireEvent.click(checkboxes[0]!)

    expect(view.getByTestId('project-todo-header-badge').textContent).toBe('1')
    expect(view.getAllByTestId('project-todo-item-row')).toHaveLength(1)

    // Expand Done (1), verify the completed item appears, then clear done.
    fireEvent.click(view.getByTestId('project-todos-done-toggle'))
    expect(view.getAllByTestId('project-todo-item-row')).toHaveLength(2)

    fireEvent.click(view.getByTestId('project-todos-clear-done'))
    expect(view.queryByTestId('project-todos-done-toggle')).toBeNull()
    expect(view.getAllByTestId('project-todo-item-row')).toHaveLength(1)
  })
})

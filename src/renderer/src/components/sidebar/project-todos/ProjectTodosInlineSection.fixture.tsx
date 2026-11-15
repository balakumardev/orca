import React, { useLayoutEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import type { Repo } from '../../../../../shared/repo-types'
import type { GroupHeaderRow } from '../../../../../shared/sidebar-list/row-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { ProjectHeaderActions } from '../worktree-list/rows/ProjectHeaderActions'
import { ProjectTodoHeaderActionButton, ProjectTodoHeaderBadge } from './ProjectTodoHeaderControls'
import { ProjectTodosInlineSection } from './ProjectTodosInlineSection'
import { useProjectTodosStore } from './project-todos-store'

const repo: Repo = {
  id: 'orca',
  path: '/preview/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'orca::/preview/orca/sidebar-polish',
  repoId: repo.id,
  hostId: 'local',
  instanceId: 'sidebar-polish-inst',
  path: '/preview/orca/sidebar-polish',
  displayName: 'sidebar-polish',
  branch: 'feat/sidebar-polish',
  head: 'abc1234',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
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

function SidebarTodosPreview({ expandDone }: { expandDone: boolean }): React.JSX.Element {
  useLayoutEffect(() => {
    useProjectTodosStore.setState({
      hydrated: true,
      hasLocalMutations: false,
      expandedSectionKeys: new Set(['repo:orca']),
      doneExpandedSectionKeys: expandDone ? new Set(['repo:orca']) : new Set(),
      focusInputSectionKey: null,
      pendingCreationById: {
        'creating-1': { projectKey: 'repo:orca', todoId: 'todo-creating' }
      },
      projects: {
        'repo:orca': [
          {
            id: 'todo-plain',
            text: 'Keyboard shortcut audit for split panes',
            done: false,
            createdAt: 3
          },
          {
            id: 'todo-linked',
            text: 'Polish sticky header handoff in sidebar',
            done: false,
            createdAt: 2,
            worktree: {
              worktreeId: worktree.id,
              hostId: 'local',
              displayName: 'sidebar-polish'
            }
          },
          {
            id: 'todo-creating',
            text: 'Investigate flaky PTY teardown on macOS',
            done: false,
            createdAt: 1
          },
          {
            id: 'todo-done-1',
            text: 'Tighten custom updater zip size guard',
            done: true,
            createdAt: 0,
            completedAt: 10,
            worktree: {
              worktreeId: 'orca::/preview/orca/zip-guard',
              hostId: 'local',
              displayName: 'zip-guard'
            }
          },
          {
            id: 'todo-done-2',
            text: 'Remove unused legacy Cmd+J task rows',
            done: true,
            createdAt: 0,
            completedAt: 9
          }
        ]
      }
    })
  }, [expandDone])

  return (
    <div className="w-[300px] bg-worktree-sidebar py-2 pl-1 text-worktree-sidebar-foreground">
      <div className="group relative flex h-7 w-full items-center gap-1.5 pr-2 pl-2.5 text-left">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <RepoIconGlyph
            repoIcon={repo.repoIcon}
            className="size-4 text-muted-foreground"
            iconClassName="size-3.5"
          />
          <div className="min-w-0 truncate text-[13px] font-semibold leading-4">orca</div>
          <ProjectTodoHeaderBadge row={headerRow} groupBy="repo" />
        </div>
        <ProjectHeaderActions>
          <div className="flex size-5 items-center justify-center rounded-md text-muted-foreground">
            <ChevronDown className="size-3.5" />
          </div>
          <ProjectTodoHeaderActionButton row={headerRow} groupBy="repo" />
        </ProjectHeaderActions>
      </div>

      <ProjectTodosInlineSection headerRow={headerRow} sectionKey="repo:orca" />
    </div>
  )
}

export const ExpandedWithOpenTodos = defineFixture({
  width: 300,
  store: {
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] }
  },
  render: () => <SidebarTodosPreview expandDone={false} />
})

export const ExpandedWithCompletedVisible = defineFixture({
  width: 300,
  store: {
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] }
  },
  render: () => <SidebarTodosPreview expandDone={true} />
})

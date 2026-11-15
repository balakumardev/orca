import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { applyRemoveWorktreeSuccessState } from '@/store/slices/worktrees/teardown/remove-worktree-store-cleanup'
import { buildWorktreePurgeState } from '@/store/slices/worktrees/teardown/worktree-purge-state'
import { completeWorktreeCreation } from '@/lib/workspace/creation/worktree-creation-completion'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import type { Repo } from '../../../../../shared/repo-types'
import type { GroupHeaderRow } from '../../../../../shared/sidebar-list/row-types'
import { slugifyTodoWorktreeName } from '../../../../../shared/project-todos-types'
import { buildRenderableRows } from '../worktree-list/listing/renderable-rows'
import { startWorktreeFromProjectTodo } from './project-todo-worktree-actions'
import { useProjectTodosStore } from './project-todos-store'

const repo: Repo = {
  id: 'repo-orca',
  path: '/workspace/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const headerRow: GroupHeaderRow = {
  type: 'header',
  key: 'repo:repo-orca',
  collapseKey: 'repo:repo-orca',
  label: 'orca',
  count: 1,
  icon: { kind: 'project' },
  repo
}

describe('project TODOs worktree lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        pty: { kill: vi.fn() }
      }
    })
    useAppStore.setState(useAppStore.getInitialState(), true)
    useProjectTodosStore.setState(useProjectTodosStore.getInitialState(), true)
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: {
        [repo.id]: [
          makeWorktree({
            id: 'wt-existing',
            repoId: repo.id,
            path: '/workspace/orca/existing',
            branch: 'feat/existing',
            displayName: 'Existing feature',
            hostId: 'local'
          })
        ]
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts a worktree from a TODO with a slugified name and auto-links it when creation completes', async () => {
    const todo = useProjectTodosStore
      .getState()
      .addTodo('repo:repo-orca', "Fix sidebar's sticky scroll jump on resize!")!
    expect(slugifyTodoWorktreeName(todo.text)).toBe('fix-sidebars-sticky-scroll-jump-on')

    startWorktreeFromProjectTodo({
      headerRow,
      projectKey: 'repo:repo-orca',
      todo
    })

    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toMatchObject({
      initialRepoId: 'repo-orca',
      prefilledName: 'fix-sidebars-sticky-scroll-jump-on',
      todoLink: { projectKey: 'repo:repo-orca', todoId: todo.id }
    })

    const request: WorktreeCreationRequest = {
      repoId: repo.id,
      name: 'fix-sidebars-sticky-scroll-jump-on',
      setupDecision: 'skip',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    }
    const creationId = 'creation-1'
    useAppStore.getState().beginPendingWorktreeCreation({
      creationId,
      request,
      status: 'creating',
      phase: 'creating',
      indeterminate: false,
      startedAt: 100,
      loaderVisible: false
    })
    useAppStore.getState().closeModal()

    expect(useProjectTodosStore.getState().pendingCreationById[creationId]).toEqual({
      projectKey: 'repo:repo-orca',
      todoId: todo.id
    })

    const createdWorktree = makeWorktree({
      id: 'wt-created',
      repoId: repo.id,
      path: '/workspace/orca/fix-sticky',
      branch: 'feat/fix-sidebars-sticky-scroll-jump-on',
      displayName: 'Fix sticky scroll',
      hostId: 'local'
    })
    useAppStore.setState({
      worktreesByRepo: {
        [repo.id]: [...useAppStore.getState().worktreesByRepo[repo.id]!, createdWorktree]
      }
    })

    await completeWorktreeCreation({
      creationId,
      request,
      worktreeId: createdWorktree.id,
      structuredLaunchAccepted: true,
      activation: false,
      primaryTabId: null,
      backendSpawned: true,
      hostPlannedStartup: false,
      focusOnCompletion: false
    })

    const updated = useProjectTodosStore.getState().projects['repo:repo-orca']?.[0]
    expect(updated?.done).toBe(false)
    expect(updated?.worktree).toEqual({
      worktreeId: 'wt-created',
      hostId: 'local',
      displayName: 'Fix sticky scroll'
    })
    expect(useProjectTodosStore.getState().pendingCreationById).toEqual({})
  })

  it('auto-marks a linked TODO as done on UI worktree delete and CLI purge, but keeps it open on sleep', () => {
    const uiTodo = useProjectTodosStore.getState().addTodo('repo:repo-orca', 'Clean up dead CSS')!
    const cliTodo = useProjectTodosStore.getState().addTodo('repo:repo-orca', 'Audit IPC channels')!
    const remoteTwinTodo = useProjectTodosStore
      .getState()
      .addTodo('repo:repo-orca', 'Remote twin stays open')!

    useProjectTodosStore.getState().assignTodoWorktree('repo:repo-orca', uiTodo.id, {
      worktreeId: 'wt-existing',
      hostId: 'local',
      displayName: 'Existing feature'
    })
    useProjectTodosStore.getState().assignTodoWorktree('repo:repo-orca', cliTodo.id, {
      worktreeId: 'wt-cli',
      hostId: 'local',
      displayName: 'CLI worktree'
    })
    useProjectTodosStore.getState().assignTodoWorktree('repo:repo-orca', remoteTwinTodo.id, {
      worktreeId: 'wt-existing',
      hostId: 'ssh:botbox',
      displayName: 'Remote twin'
    })

    // Putting a worktree to sleep (isArchived: true) must NOT complete the TODO.
    useAppStore.setState({
      worktreesByRepo: {
        [repo.id]: [
          makeWorktree({
            id: 'wt-existing',
            repoId: repo.id,
            path: '/workspace/orca/existing',
            isArchived: true,
            hostId: 'local'
          }),
          makeWorktree({
            id: 'wt-cli',
            repoId: repo.id,
            path: '/workspace/orca/cli',
            hostId: 'local'
          })
        ]
      }
    })
    expect(
      useProjectTodosStore.getState().projects['repo:repo-orca']?.find((t) => t.id === uiTodo.id)
        ?.done
    ).toBe(false)

    // Deleting wt-existing on local host completes uiTodo, while leaving ssh:botbox twin open.
    applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-existing', new Set(), 'local')

    const afterUiDelete = useProjectTodosStore.getState().projects['repo:repo-orca']!
    expect(afterUiDelete.find((t) => t.id === uiTodo.id)?.done).toBe(true)
    expect(afterUiDelete.find((t) => t.id === remoteTwinTodo.id)?.done).toBe(false)
    expect(afterUiDelete.find((t) => t.id === cliTodo.id)?.done).toBe(false)

    // External/CLI worktree removal goes through buildWorktreePurgeState and marks cliTodo done.
    buildWorktreePurgeState(useAppStore.getState(), ['wt-cli'])
    const afterCliPurge = useProjectTodosStore.getState().projects['repo:repo-orca']!
    expect(afterCliPurge.find((t) => t.id === cliTodo.id)?.done).toBe(true)

    // Clear done removes completed items while keeping open items.
    useProjectTodosStore.getState().clearCompletedTodos('repo:repo-orca')
    expect(
      useProjectTodosStore.getState().projects['repo:repo-orca']?.map((item) => item.id)
    ).toEqual([remoteTwinTodo.id])
  })

  it('inserts an inline project-todos row beneath an expanded project header and closes when the header collapses', () => {
    useProjectTodosStore.getState().openTodoSection('repo:repo-orca')

    const rendered = buildRenderableRows(
      [headerRow],
      useProjectTodosStore.getState().expandedSectionKeys
    )
    expect(rendered.map((row) => row.type)).toEqual(['header', 'project-todos'])

    useAppStore.setState({ collapsedGroups: new Set(['repo:repo-orca']) })
    expect(useProjectTodosStore.getState().expandedSectionKeys.has('repo:repo-orca')).toBe(false)
  })
})

import { useMemo } from 'react'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspaces/folder-workspace-host-id'
import {
  slugifyTodoWorktreeName,
  type ProjectTodoItem,
  type ProjectTodoWorktreeLink
} from '../../../../../shared/project-todos-types'
import {
  isSingleHostProjectHeader,
  type GroupHeaderRow
} from '../../../../../shared/sidebar-list/row-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { branchName } from '@/lib/source-control/branches/branch-name'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { getHeaderCreateWorkspaceTarget } from '../worktree-list/rows/header-create-workspace-target'

export type AssignableProjectWorktreeOption = {
  worktreeId: string
  hostId: ExecutionHostId | null
  displayName: string
  branchLabel: string | null
}

export function startWorktreeFromProjectTodo(args: {
  headerRow: GroupHeaderRow
  projectKey: string
  todo: ProjectTodoItem
}): void {
  const { headerRow, projectKey, todo } = args
  const { repos, projectHostSetups, openModal } = useAppStore.getState()
  const prefilledName = slugifyTodoWorktreeName(todo.text)
  const todoLink = { projectKey, todoId: todo.id }

  if (headerRow.repo) {
    const pinHost = isSingleHostProjectHeader(headerRow)
    openModal('new-workspace-composer', {
      initialRepoId: headerRow.repo.id,
      ...(prefilledName ? { prefilledName } : {}),
      ...(pinHost ? getHeaderCreateWorkspaceTarget(headerRow.repo, repos, projectHostSetups) : {}),
      todoLink,
      telemetrySource: 'sidebar'
    })
    return
  }

  if (
    headerRow.projectGroup &&
    'parentPath' in headerRow.projectGroup &&
    headerRow.projectGroup.parentPath
  ) {
    openModal('new-workspace-composer', {
      initialProjectGroupId: headerRow.projectGroup.id,
      ...(prefilledName ? { prefilledName } : {}),
      todoLink,
      telemetrySource: 'sidebar'
    })
  }
}

export function activateProjectTodoWorktree(link: ProjectTodoWorktreeLink): void {
  void activateWorktreeFromSidebar(link.worktreeId, link.hostId ?? undefined)
}

export function useProjectAvailableWorktrees(
  headerRow: GroupHeaderRow
): readonly AssignableProjectWorktreeOption[] {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const projectGroups = useAppStore((s) => s.projectGroups)

  return useMemo(() => {
    const repoIds = new Set<string>()
    if (headerRow.repo) {
      repoIds.add(headerRow.repo.id)
    }
    if (headerRow.anchorRepo) {
      repoIds.add(headerRow.anchorRepo.id)
    }
    if (headerRow.hostRepos) {
      for (const repo of headerRow.hostRepos.values()) {
        repoIds.add(repo.id)
      }
    }

    if (repoIds.size > 0) {
      const options: AssignableProjectWorktreeOption[] = []
      const seen = new Set<string>()
      for (const repoId of repoIds) {
        const repo = repos.find((r) => r.id === repoId) ?? headerRow.repo
        const list = worktreesByRepo[repoId] ?? []
        for (const wt of list) {
          const hostId = getWorktreeExecutionHostId(wt, repo) ?? null
          if (headerRow.hostId && hostId && hostId !== headerRow.hostId) {
            continue
          }
          const dedupeKey = `${hostId ?? ''}:${wt.id}`
          if (seen.has(dedupeKey)) {
            continue
          }
          seen.add(dedupeKey)
          const shortBranch = branchName(wt.branch)
          const displayName = wt.displayName?.trim() || shortBranch || wt.id
          options.push({
            worktreeId: wt.id,
            hostId,
            displayName,
            branchLabel: shortBranch && shortBranch !== displayName ? shortBranch : null
          })
        }
      }
      return options
    }

    if (
      headerRow.projectGroup &&
      'parentPath' in headerRow.projectGroup &&
      headerRow.projectGroup.parentPath
    ) {
      const groupId = headerRow.projectGroup.id
      return folderWorkspaces
        .filter((fw) => fw.projectGroupId === groupId)
        .map((fw) => ({
          worktreeId: folderWorkspaceKey(fw.id),
          hostId: getFolderWorkspaceHostId(fw, projectGroups ?? []) ?? null,
          displayName: fw.name,
          branchLabel: null
        }))
    }

    return []
  }, [folderWorkspaces, headerRow, projectGroups, repos, worktreesByRepo])
}

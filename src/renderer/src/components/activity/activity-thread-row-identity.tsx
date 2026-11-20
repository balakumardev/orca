import React from 'react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import type { Repo } from '../../../../shared/repository/repo-types'
import { resolveRepoHeaderColor } from '../sidebar/worktree-list/rows/project-header-color'

function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// Reads the project from the thread, not the store, so memoized rows stay cheap.
export function ActivityThreadRowIdentity({
  repo,
  workspaceLabel
}: {
  repo: Repo | null
  workspaceLabel: string
}): React.JSX.Element {
  // A main checkout is often named after its project; the chip would only repeat it.
  const showProject = repo !== null && !sameLabel(repo.displayName, workspaceLabel)
  return (
    // Why: the project gets at most 45% of this group so a long project name never pushes the workspace name out of a narrow sidebar.
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {showProject ? (
        <span
          className="inline-flex h-4 max-w-[45%] min-w-0 shrink items-center gap-0.5 rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55 px-0.5"
          title={repo.displayName}
        >
          <span className="inline-flex size-3 shrink-0 items-center justify-center text-2xs">
            <RepoIconGlyph
              repoIcon={repo.repoIcon}
              color={resolveRepoHeaderColor(repo.badgeColor)}
              className="size-full"
              iconClassName="size-3"
            />
          </span>
          <span className="min-w-0 truncate text-3xs leading-none text-muted-foreground lowercase">
            {repo.displayName}
          </span>
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={workspaceLabel}>
        {workspaceLabel}
      </span>
    </span>
  )
}

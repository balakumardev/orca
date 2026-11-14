import type React from 'react'
import { Folder, FolderGit2, GitBranch } from 'lucide-react'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { folderParentPath } from './palette-folder-results'

export function PaletteFolderLeading({
  kind
}: {
  kind: FolderSearchEntry['kind']
}): React.JSX.Element {
  const Icon = kind === 'git-root' ? FolderGit2 : kind === 'linked-worktree' ? GitBranch : Folder
  return (
    <span
      data-folder-search-kind={kind}
      className="flex h-5 w-4 items-center justify-center text-muted-foreground/85"
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  )
}

export function PaletteFolderParentLine({ path }: { path: string }): React.JSX.Element {
  return <span>{folderParentPath(path)}</span>
}

/** A directory the Cmd+J Folders section offers that Orca does not track yet. */
export type FolderSearchEntryKind = 'git-root' | 'linked-worktree' | 'folder'

export type FolderSearchEntry = {
  path: string
  kind: FolderSearchEntryKind
  /** The on-disk path with links resolved and letter case as the disk spells it; main always sets it. */
  realPath?: string
}

export type FolderSearchResult = {
  entries: FolderSearchEntry[]
  /** The scan hit its entry cap or time budget, or a read hung; some folders may be missing. */
  truncated: boolean
}

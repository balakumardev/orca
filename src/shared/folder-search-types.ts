import type { ExecutionHostId } from './execution-host/execution-host'
import { z } from 'zod'

/** Paired runtimes discover folders from their own saved locations. */
export const FOLDER_SEARCH_CAPABILITY = 'folderSearch.v1'

/** Resolving accepts only a previously offered path, never caller-supplied search roots. */
export const FolderSearchResolveParams = z.object({ path: z.string().min(1) }).strict()

/** A directory the Cmd+J Folders section offers that Orca does not track yet. */
export type FolderSearchEntryKind = 'git-root' | 'linked-worktree' | 'folder'

export type FolderSearchEntry = {
  path: string
  kind: FolderSearchEntryKind
  /** The on-disk path with links resolved and letter case as the disk spells it; main always sets it. */
  realPath?: string
  /** Main assigns the addressed host; a remote response cannot choose its routing identity. */
  executionHostId?: ExecutionHostId
}

export type FolderSearchResult = {
  entries: FolderSearchEntry[]
  /** The scan hit its entry cap or time budget, or a read hung; some folders may be missing. */
  truncated: boolean
}

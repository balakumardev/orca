import type { FolderSearchEntry, FolderSearchResult } from '../../shared/folder-search-types'
import type { ExecutionHostId } from '../../shared/execution-host'

export type FolderSearchApi = {
  /** Omitting the host keeps existing callers on this machine. */
  list: (executionHostId?: ExecutionHostId) => Promise<FolderSearchResult>
  /** The picked folder as it is now, or null when it is gone, is not one main listed, or is tracked by now. */
  resolve: (path: string, executionHostId?: ExecutionHostId) => Promise<FolderSearchEntry | null>
}

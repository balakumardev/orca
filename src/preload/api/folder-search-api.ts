import type { FolderSearchEntry, FolderSearchResult } from '../../shared/folder-search-types'

export type FolderSearchApi = {
  list: () => Promise<FolderSearchResult>
  /** The picked folder as it is now, or null when it is gone, is not one main listed, or is tracked by now. */
  resolve: (path: string) => Promise<FolderSearchEntry | null>
}

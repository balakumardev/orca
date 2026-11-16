import type { GlobalSettings } from './global-settings-types'

/** Limit the number of independent filesystem walks started by one palette open. */
export const MAX_FOLDER_SEARCH_ROOTS = 12

/** Older and fresh profiles search Home; an explicitly empty list disables folder discovery. */
export function getFolderSearchLocations(
  settings: Pick<GlobalSettings, 'folderSearchLocations'>
): string[] {
  if (!Array.isArray(settings.folderSearchLocations)) {
    return ['~']
  }
  return [
    ...new Set(
      settings.folderSearchLocations.filter(
        (location) => typeof location === 'string' && location.trim().length > 0
      )
    )
  ].slice(0, MAX_FOLDER_SEARCH_ROOTS)
}

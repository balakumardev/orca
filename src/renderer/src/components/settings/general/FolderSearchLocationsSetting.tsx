import { useState } from 'react'
import { FolderPlus, RotateCcw } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  getFolderSearchLocations,
  MAX_FOLDER_SEARCH_ROOTS
} from '../../../../../shared/folder-search-settings'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { GENERAL_SETTING_ANCHORS } from './general-setting-anchors'

type FolderSearchLocationsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** Keep async cleanup outside the component so React Compiler can optimize its render. */
async function changeFolderSearchLocations({
  next,
  locations,
  updateSettings,
  setBusy,
  setError
}: {
  next?: string[]
  locations: string[]
  updateSettings: FolderSearchLocationsSettingProps['updateSettings']
  setBusy: (busy: boolean) => void
  setError: (error: boolean) => void
}): Promise<void> {
  setBusy(true)
  setError(false)
  try {
    // An omitted list adds native-picker selections; Cancel leaves the saved roots alone.
    if (!next) {
      const picked = await window.api.repos.pickFolders()
      if (picked.length === 0) {
        return
      }
      next = [...locations, ...picked]
    }
    await updateSettings({
      folderSearchLocations: getFolderSearchLocations({ folderSearchLocations: next })
    })
  } catch {
    setError(true)
  } finally {
    setBusy(false)
  }
}

/** Local settings and the native picker keep folder discovery independent of the focused server. */
export function FolderSearchLocationsSetting({
  settings,
  updateSettings
}: FolderSearchLocationsSettingProps) {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const locations = getFolderSearchLocations(settings)
  const title = t('settings.folderSearch.title', 'Folder search locations')
  const description = t(
    'settings.folderSearch.description',
    'Search these local folders and up to three levels of subfolders in the jump palette.'
  )

  function changeLocations(next?: string[]): Promise<void> {
    return changeFolderSearchLocations({ next, locations, updateSettings, setBusy, setError })
  }

  if (isWebClientLocation()) {
    return null
  }

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.folderSearch}
      title={title}
      description={description}
      keywords={['folder', 'search', 'locations', 'home', 'palette', 'roots']}
      className="space-y-2 py-3"
    >
      <div className="text-sm font-medium">{title}</div>
      <p className="text-settings-detail text-muted-foreground">{description}</p>
      <ul aria-label={title} className="space-y-1">
        {locations.map((location) => (
          <li key={location} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={location}>
              {location === '~' ? t('settings.folderSearch.home', 'Home (~)') : location}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={t('settings.folderSearch.removeLocation', 'Remove {{location}}', {
                location
              })}
              onClick={() => void changeLocations(locations.filter((path) => path !== location))}
            >
              {t('settings.folderSearch.remove', 'Remove')}
            </Button>
          </li>
        ))}
      </ul>
      {locations.length === 0 && (
        <p className="text-settings-detail text-muted-foreground">
          {t('settings.folderSearch.empty', 'Add a folder to enable folder discovery.')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || locations.length >= MAX_FOLDER_SEARCH_ROOTS}
          onClick={() => void changeLocations()}
        >
          <FolderPlus className="size-4" />
          {t('settings.folderSearch.add', 'Add folders')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || (locations.length === 1 && locations[0] === '~')}
          onClick={() => void changeLocations(['~'])}
        >
          <RotateCcw className="size-4" />
          {t('settings.folderSearch.reset', 'Use home directory')}
        </Button>
      </div>
      <p className="text-settings-detail text-muted-foreground">
        {t('settings.folderSearch.limit', 'Up to {{count}} locations on this computer.', {
          count: MAX_FOLDER_SEARCH_ROOTS
        })}
      </p>
      {error && (
        <p role="alert" className="text-settings-detail text-destructive">
          {t(
            'settings.folderSearch.saveError',
            'Could not update folder search locations. Try again.'
          )}
        </p>
      )}
    </SearchableSetting>
  )
}

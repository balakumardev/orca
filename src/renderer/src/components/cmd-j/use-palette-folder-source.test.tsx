// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import type { Translate } from '@/i18n/use-translate'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import type { PaletteExtraSource } from './palette-extra-results'
import { openFolderEntryInApp } from './palette-folder-open-in-app'
import { usePaletteFolderSource } from './use-palette-folder-source'

vi.mock('@/app-shell/platform/web-client-location', () => ({ isWebClientLocation: vi.fn() }))
vi.mock('./palette-folder-open-in-app', () => ({ openFolderEntryInApp: vi.fn() }))

const notes: FolderSearchEntry = { path: '/code/notes', kind: 'folder' }
const orca: FolderSearchEntry = { path: '/code/orca', kind: 'git-root' }
const fallbackTranslate: Translate = (_key, fallback) => fallback
const label = (source: PaletteExtraSource | null): string | undefined =>
  source?.sectionLabel(fallbackTranslate)

function installBridge(api: unknown): void {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

function renderSource(initial: { query: string; visible: boolean }) {
  return renderHook((props) => usePaletteFolderSource(props), { initialProps: initial })
}

beforeEach(() => {
  vi.mocked(isWebClientLocation).mockReturnValue(false)
  vi.mocked(openFolderEntryInApp).mockReset()
})
afterEach(cleanup)

describe('usePaletteFolderSource', () => {
  it('offers the folders that match a typed query, under a Folders heading', async () => {
    installBridge({
      folderSearch: { list: async () => ({ entries: [notes, orca], truncated: false }) }
    })
    const { result } = renderSource({ query: 'orca', visible: true })
    await act(async () => {})
    expect(result.current?.results.map((row) => row.id)).toEqual(['/code/orca'])
    expect(label(result.current)).toBe('Folders')
  })

  it('says the list is partial when the scan was cut short', async () => {
    installBridge({ folderSearch: { list: async () => ({ entries: [orca], truncated: true }) } })
    const { result } = renderSource({ query: 'orca', visible: true })
    await act(async () => {})
    expect(label(result.current)).toBe('Folders (partial list)')
  })

  it('offers nothing for an empty query', async () => {
    installBridge({ folderSearch: { list: async () => ({ entries: [orca], truncated: false }) } })
    const { result } = renderSource({ query: '', visible: true })
    await act(async () => {})
    expect(result.current).toBeNull()
  })

  it('reads the list once per open, however many keystrokes follow', async () => {
    const list = vi.fn(async () => ({ entries: [orca], truncated: false }))
    installBridge({ folderSearch: { list } })
    const { rerender } = renderSource({ query: 'o', visible: true })
    await act(async () => {})
    rerender({ query: 'or', visible: true })
    rerender({ query: 'orc', visible: true })
    expect(list).toHaveBeenCalledTimes(1)
    rerender({ query: '', visible: false })
    rerender({ query: 'o', visible: true })
    await act(async () => {})
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps its rows while the palette closes, and starts from none at the next open', async () => {
    const list = vi.fn(async () => ({ entries: [orca], truncated: false }))
    installBridge({ folderSearch: { list } })
    const { result, rerender } = renderSource({ query: 'orca', visible: true })
    await act(async () => {})
    rerender({ query: 'orca', visible: false })
    expect(result.current?.results).toHaveLength(1)
    list.mockImplementation(() => new Promise(() => {}))
    rerender({ query: 'orca', visible: true })
    expect(result.current).toBeNull()
  })

  it('reads nothing while the palette is closed', async () => {
    const list = vi.fn(async () => ({ entries: [orca], truncated: false }))
    installBridge({ folderSearch: { list } })
    renderSource({ query: 'orca', visible: false })
    await act(async () => {})
    expect(list).not.toHaveBeenCalled()
  })

  it('reads nothing on the web client', async () => {
    vi.mocked(isWebClientLocation).mockReturnValue(true)
    const list = vi.fn(async () => ({ entries: [orca], truncated: false }))
    installBridge({ folderSearch: { list } })
    const { result } = renderSource({ query: 'orca', visible: true })
    await act(async () => {})
    expect(list).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('offers nothing, without failing, when the window has no folder search bridge', async () => {
    installBridge({})
    const { result } = renderSource({ query: 'orca', visible: true })
    await act(async () => {})
    expect(result.current).toBeNull()
  })

  it('drops an answer that arrives after the palette closed', async () => {
    let answer: (value: { entries: FolderSearchEntry[]; truncated: boolean }) => void = () => {}
    installBridge({
      folderSearch: { list: () => new Promise((resolve) => (answer = resolve)) }
    })
    const { result, rerender } = renderSource({ query: 'orca', visible: true })
    rerender({ query: 'orca', visible: false })
    await act(async () => answer({ entries: [orca], truncated: false }))
    expect(result.current).toBeNull()
  })

  it('keeps well-formed entries and ignores anything else the bridge returns', async () => {
    installBridge({
      folderSearch: {
        list: async () => ({
          entries: [{ path: 7 }, 'junk', { path: '/code/orca', kind: 'moon' }, orca],
          truncated: false
        })
      }
    })
    const { result } = renderSource({ query: 'orca', visible: true })
    await act(async () => {})
    expect(result.current?.results.map((row) => row.id)).toEqual(['/code/orca'])
  })

  it('opens the entry a row stands for when it is selected', async () => {
    installBridge({ folderSearch: { list: async () => ({ entries: [orca], truncated: false }) } })
    const { result } = renderSource({ query: 'orca', visible: true })
    await act(async () => {})
    result.current?.results[0].onSelect()
    expect(openFolderEntryInApp).toHaveBeenCalledExactlyOnceWith(orca)
  })
})

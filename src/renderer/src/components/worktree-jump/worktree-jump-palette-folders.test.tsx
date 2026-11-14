// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreePaletteRequestGuard } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { useAppStore } from '@/store/index'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { useWorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { makeRecentTabState, makeRepo } from './worktree-jump-palette-test-fixtures'

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const initialAppState = useAppStore.getInitialState()

function folderEntry(name: string): FolderSearchEntry {
  return { path: `/code/${name}`, kind: 'folder' }
}

function installFolderBridge(entries: FolderSearchEntry[]): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      folderSearch: { list: async () => ({ entries, truncated: false }), resolve: async () => null }
    }
  })
}

function usePalette() {
  const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])
  return useWorktreeJumpPaletteController({ visible: true, lingering: true, createLookupGuard })
}

/** What the palette shows and arms for Enter after the query settles. */
async function typeToQuery(query: string, folders: FolderSearchEntry[]) {
  installFolderBridge(folders)
  const { result, unmount } = renderHook(usePalette)
  await act(async () => {})
  await act(async () => result.current.handleQueryChange(query))
  await act(async () => {})
  const snapshot = {
    entries: result.current.listEntries.map((entry) => ({
      id: entry.id,
      folder:
        entry.id === '__header_extra_folders__' ||
        (entry.type === 'extra' && entry.sourceId === 'folders')
    })),
    armedId: result.current.commandSelectedItemId
  }
  unmount()
  return snapshot
}

type Snapshot = Awaited<ReturnType<typeof typeToQuery>>

function withoutFolders(snapshot: Snapshot): string[] {
  return snapshot.entries.filter((entry) => !entry.folder).map((entry) => entry.id)
}

describe('Cmd+J Folders section does not take over the list or Enter', () => {
  beforeEach(() => {
    useAppStore.setState(
      {
        ...initialAppState,
        ...makeRecentTabState(),
        repos: [makeRepo()],
        activeWorktreeId: 'wt-alpha',
        activeModal: 'worktree-palette'
      },
      true
    )
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
  })

  // Each query matches a quick action or a tab, and a folder of the same name.
  it.each(['browser', 'new', 'split', 'terminal'])(
    'keeps the rows, their order and the armed row for "%s" when a folder matches by name',
    async (name) => {
      const baseline = await typeToQuery(name, [])
      const withFolder = await typeToQuery(name, [folderEntry(name)])

      expect(withFolder.entries.some((entry) => entry.folder)).toBe(true)
      expect(withoutFolders(withFolder)).toEqual(withoutFolders(baseline))
      expect(withFolder.armedId).toBe(baseline.armedId)
      // The first row the user saw before is still above every folder.
      const firstRowBefore = withoutFolders(baseline).find((id) => !id.startsWith('__'))
      const indexOf = (id: string | undefined) =>
        withFolder.entries.findIndex((entry) => entry.id === id)
      expect(indexOf(firstRowBefore)).toBeLessThan(
        withFolder.entries.findIndex((entry) => entry.folder)
      )
    }
  )

  it('does not arm Enter for a folder that is the only match', async () => {
    const baseline = await typeToQuery('zzquartz', [])
    const withFolder = await typeToQuery('zzquartz', [folderEntry('zzquartz')])

    expect(baseline.armedId).toBe('')
    expect(withFolder.entries.some((entry) => entry.folder)).toBe(true)
    expect(withFolder.armedId).toBe('')
  })

  it('lists exactly what it listed before when the query is empty', async () => {
    const baseline = await typeToQuery('', [])
    const withFolder = await typeToQuery('', [folderEntry('browser'), folderEntry('zzquartz')])

    expect(withFolder).toEqual(baseline)
  })
})

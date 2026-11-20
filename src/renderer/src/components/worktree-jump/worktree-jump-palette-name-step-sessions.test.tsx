// @vitest-environment happy-dom

import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  endProjectNameStep,
  getProjectNameStep
} from '@/components/cmd-j/palette-project-name-step-store'
import { isUnarmedByDefaultPaletteItemId } from '@/components/cmd-j/palette-folder-selection'
import { sessionHit } from '../cmd-j/palette-session-hit.test-fixture'
import type {
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../../../shared/ai-vault/search/ai-vault-search-types'
import {
  highlight,
  initialAppState,
  keyEvent,
  modEnter,
  openPaletteAt,
  seedProjects,
  type Palette
} from './worktree-jump-palette-project-create-test-fixtures'

vi.mock('@/components/settings/navigation/useSettingsNavigationMetadata', () => ({
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

const READY: AiVaultSearchStatus = {
  enabled: true,
  phase: 'current',
  filesIndexed: 12,
  filesDue: 0,
  filesFailed: 0,
  degradedRoots: [],
  lastReconcileAt: 1794297600000,
  lastSweepCompletedAt: 1794297600000,
  generation: 1
}

const SESSION_HEADER = '__header_extra_sessions__'

function installBridges(): void {
  const results: AiVaultSearchResponse = {
    kind: 'results',
    hits: [sessionHit('s-1'), sessionHit('s-2')],
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        searchSessions: vi.fn(async () => results),
        searchStatus: vi.fn(async () => READY)
      },
      folderSearch: {
        list: async () => ({
          entries: [{ path: '/code/acme-web-old', kind: 'folder' }],
          truncated: false
        }),
        resolve: async () => null
      }
    }
  })
}

const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

const isSessionEntry = (entry: Palette['current']['controller']['listEntries'][number]): boolean =>
  entry.id === SESSION_HEADER || (entry.type === 'extra' && entry.sourceId === 'sessions')

const sessionRowCount = (palette: Palette): number =>
  palette.current.controller.listEntries.filter(
    (entry) => entry.type === 'extra' && entry.sourceId === 'sessions'
  ).length

const armedId = (palette: Palette): string => palette.current.controller.commandSelectedItemId

async function openAt(query: string): Promise<Palette> {
  const { result } = await openPaletteAt(query)
  await settle(400)
  return result
}

async function enterNameStep(palette: Palette): Promise<void> {
  await highlight(palette, (id) => id.includes('wt-web-auth'))
  await act(async () => {
    palette.current.shortcut.handleKeyDown(modEnter())
  })
  expect(getProjectNameStep()).not.toBeNull()
}

const leaveByEscape = (palette: Palette) =>
  act(async () => {
    palette.current.nameStep.handleKeyDown(
      keyEvent({ key: 'Escape', keyCode: 0, metaKey: false, ctrlKey: false })
    )
  })

describe('Cmd+J name step with the Folders and Sessions sections', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    seedProjects()
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        aiVaultSearch: { enabled: true, historyDays: null }
      }
    })
    installBridges()
  })
  afterEach(() => {
    cleanup()
    endProjectNameStep()
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(initialAppState, true)
  })

  it('lists the Folders section, then the Sessions section, then the Create group last', async () => {
    const palette = await openAt('acme-web')
    const ids = palette.current.controller.listEntries.map((entry) => entry.id)
    const [folders, sessions, create] = [
      ids.indexOf('__header_extra_folders__'),
      ids.indexOf(SESSION_HEADER),
      ids.indexOf('__header_extra_project-create__')
    ]

    expect(folders).toBeGreaterThan(0)
    expect(sessions).toBeGreaterThan(folders)
    expect(create).toBeGreaterThan(sessions)
  })

  it('puts the search back with the sessions listed and arms the row it armed without the step', async () => {
    const baseline = await openAt('acme-web')
    expect(sessionRowCount(baseline)).toBe(2)
    const armedWithoutStep = armedId(baseline)
    expect(armedWithoutStep).toContain('wt-web')
    cleanup()

    const palette = await openAt('acme-web')
    await enterNameStep(palette)
    await leaveByEscape(palette)
    await settle(400)

    expect(getProjectNameStep()).toBeNull()
    expect(sessionRowCount(palette)).toBe(2)
    expect(armedId(palette)).toBe(armedWithoutStep)
    expect(isUnarmedByDefaultPaletteItemId(armedId(palette))).toBe(false)
  })

  it('arms no session when the hits land while the step is open and the step is then left', async () => {
    const { result: palette } = await openPaletteAt('acme-web')
    await enterNameStep(palette)
    // The debounced search resolves behind the hidden list; nothing the step does may arm what it brings.
    await settle(400)
    expect(sessionRowCount(palette)).toBe(2)
    await leaveByEscape(palette)
    await settle(400)

    expect(sessionRowCount(palette)).toBe(2)
    expect(isUnarmedByDefaultPaletteItemId(armedId(palette))).toBe(false)
    expect(palette.current.controller.listEntries.filter(isSessionEntry).length).toBeGreaterThan(0)
  })

  it('arms nothing for a search that only sessions match, and the step leaves it that way', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-web-auth' })
    const baseline = await openAt('zzquartz')
    expect(sessionRowCount(baseline)).toBe(2)
    expect(isUnarmedByDefaultPaletteItemId(armedId(baseline))).toBe(false)
    const armedWithoutStep = armedId(baseline)
    cleanup()

    const palette = await openAt('zzquartz')
    await act(async () => {
      palette.current.shortcut.handleKeyDown(keyEvent({ shiftKey: true }))
    })
    expect(getProjectNameStep()).not.toBeNull()
    await leaveByEscape(palette)
    await settle(400)

    expect(sessionRowCount(palette)).toBe(2)
    expect(armedId(palette)).toBe(armedWithoutStep)
    expect(isUnarmedByDefaultPaletteItemId(armedId(palette))).toBe(false)
  })

  it('does the same when the step is left by Backspace on an empty name', async () => {
    const baseline = await openAt('acme-web')
    const armedWithoutStep = armedId(baseline)
    cleanup()
    const palette = await openAt('acme-web')
    await enterNameStep(palette)
    await act(async () => {
      palette.current.nameStep.handleKeyDown(
        keyEvent({ key: 'Backspace', keyCode: 0, metaKey: false, ctrlKey: false })
      )
    })
    await settle(400)

    expect(getProjectNameStep()).toBeNull()
    expect(sessionRowCount(palette)).toBe(2)
    expect(armedId(palette)).toBe(armedWithoutStep)
  })
})

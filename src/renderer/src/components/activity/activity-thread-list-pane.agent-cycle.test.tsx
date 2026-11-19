// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadListPane } from './thread-list/activity-thread-list-pane'
import type { ActivityThreadGroup, AgentPaneThread } from './threads/activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeThread(name: string): AgentPaneThread {
  return {
    paneKey: `tab-${name}:leaf`,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1000,
    agentType: 'claude',
    unread: false,
    paneTitle: `Agent ${name}`,
    responsePreview: '',
    events: []
  }
}

const a = makeThread('A')
const b = makeThread('B')
const c = makeThread('C')
const d = makeThread('D')
const groups: ActivityThreadGroup[] = [
  { key: 'working', label: 'Working', state: 'working', threads: [a, b] },
  { key: 'done', label: 'Done', state: 'done', threads: [c, d] }
]
const manyThreads = Array.from({ length: 300 }, (_, index) => makeThread(`many-${index}`))

let container: HTMLDivElement
let root: Root
let onSelectThread: ReturnType<typeof vi.fn<(thread: AgentPaneThread) => void>>

function renderPane(options: {
  selectedPaneKey: string | null
  cycleShortcutEnabled?: boolean
  threadGroups?: ActivityThreadGroup[]
  groupBy?: 'status' | 'none'
}): void {
  const threadGroups = options.threadGroups ?? groups
  act(() => {
    root.render(
      <TooltipProvider>
        <ActivityThreadListPane
          activityFilterInputRef={{ current: null }}
          query=""
          onQueryChange={vi.fn()}
          groupBy={options.groupBy ?? 'status'}
          onGroupByChange={vi.fn()}
          readFilter="all"
          onReadFilterChange={vi.fn()}
          compactMode={true}
          hasUnreadThreads={false}
          onCompactModeChange={vi.fn()}
          visibleThreadGroups={threadGroups}
          visibleThreadCount={threadGroups.flatMap((group) => group.threads).length}
          selectedPaneKey={options.selectedPaneKey}
          onSelectThread={onSelectThread}
          onJumpToWorkspace={vi.fn()}
          onMarkThreadRead={vi.fn()}
          onMarkThreadUnread={vi.fn()}
          onMarkThreadsRead={vi.fn()}
          onMarkThreadsUnread={vi.fn()}
          canJumpToWorkspace={() => true}
          showFilterControls={false}
          showOptionsMenu={false}
          cycleShortcutEnabled={options.cycleShortcutEnabled}
        />
      </TooltipProvider>
    )
  })
}

// Ctrl+Shift+; and Ctrl+Shift+' on a Windows user agent, which is how Mod resolves there.
function pressChord(key: ':' | '"', code: string): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true
  })
  act(() => {
    window.dispatchEvent(event)
  })
  return event.defaultPrevented
}

const pressPrevious = (): boolean => pressChord(':', 'Semicolon')
const pressNext = (): boolean => pressChord('"', 'Quote')

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onSelectThread = vi.fn<(thread: AgentPaneThread) => void>()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('ActivityThreadListPane agent cycle shortcuts', () => {
  it('walks the rendered rows in order and wraps at both ends', () => {
    renderPane({ selectedPaneKey: b.paneKey, cycleShortcutEnabled: true })

    expect(pressNext()).toBe(true)
    expect(onSelectThread).toHaveBeenLastCalledWith(c)
    expect(pressPrevious()).toBe(true)
    expect(onSelectThread).toHaveBeenLastCalledWith(a)

    renderPane({ selectedPaneKey: d.paneKey, cycleShortcutEnabled: true })
    pressNext()
    expect(onSelectThread).toHaveBeenLastCalledWith(a)
    renderPane({ selectedPaneKey: a.paneKey, cycleShortcutEnabled: true })
    pressPrevious()
    expect(onSelectThread).toHaveBeenLastCalledWith(d)
  })

  it('starts at the first row going forward and the last row going back without a selection', () => {
    renderPane({ selectedPaneKey: null, cycleShortcutEnabled: true })
    pressNext()
    expect(onSelectThread).toHaveBeenLastCalledWith(a)
    pressPrevious()
    expect(onSelectThread).toHaveBeenLastCalledWith(d)
  })

  it('skips threads inside a collapsed group', () => {
    renderPane({ selectedPaneKey: b.paneKey, cycleShortcutEnabled: true })
    const doneHeader = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes('Done')
    )
    act(() => doneHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    pressNext()
    expect(onSelectThread).toHaveBeenLastCalledWith(a)
    renderPane({ selectedPaneKey: a.paneKey, cycleShortcutEnabled: true })
    pressPrevious()
    expect(onSelectThread).toHaveBeenLastCalledWith(b)
  })

  it('leaves the chords alone unless the pane enables them', () => {
    renderPane({ selectedPaneKey: a.paneKey })

    expect(pressNext()).toBe(false)
    expect(pressPrevious()).toBe(false)
    expect(onSelectThread).not.toHaveBeenCalled()
  })

  it('scrolls the activated row into view in a virtualized list', () => {
    const [first] = manyThreads
    renderPane({
      selectedPaneKey: first.paneKey,
      cycleShortcutEnabled: true,
      threadGroups: [{ key: 'done', label: 'Done', state: 'done', threads: manyThreads }],
      groupBy: 'none'
    })
    const scrollTo = vi.fn()
    const scrollContainer = container.querySelector<HTMLElement>('.overflow-y-auto')
    if (scrollContainer) {
      scrollContainer.scrollTo = scrollTo
      // happy-dom has no layout; the virtualizer clamps targets to the container's scroll height.
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 30_000 })
    }

    pressPrevious()

    expect(onSelectThread).toHaveBeenLastCalledWith(manyThreads[299])
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number) }))
    expect(scrollTo.mock.calls[0][0].top).toBeGreaterThan(20_000)
  })
})

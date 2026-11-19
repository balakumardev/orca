import { describe, expect, it } from 'vitest'
import {
  decideActivityFollow,
  findCollapsedGroupKeyHolding,
  type ActivityFollowInput
} from './activity-follow-focused-agent'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'
import type { ActivityThreadGroup, AgentPaneThread } from './threads/activity-thread-types'

const NOTHING_FOLLOWED: ActivityFollowInput = {
  active: true,
  focusedPaneKey: null,
  selectedPaneKey: null,
  focusedRowListed: true,
  adoptedPaneKey: null,
  previousSelectedPaneKey: null,
  followedPaneKey: null,
  wasActive: true
}

function makeThread(paneKey: string): AgentPaneThread {
  return {
    paneKey,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1000,
    agentType: 'claude',
    unread: false,
    paneTitle: paneKey,
    responsePreview: '',
    events: []
  }
}

describe('decideActivityFollow', () => {
  it('highlights the agent that starts in the focused pane', () => {
    const decision = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: 'tab-2:leaf-b',
      selectedPaneKey: 'tab-1:leaf-a',
      previousSelectedPaneKey: 'tab-1:leaf-a'
    })

    expect(decision.highlightPaneKey).toBe('tab-2:leaf-b')
    expect(decision.reveal).toBe(true)
    expect(decision.memory).toEqual({
      adoptedPaneKey: 'tab-2:leaf-b',
      previousSelectedPaneKey: 'tab-1:leaf-a',
      followedPaneKey: 'tab-2:leaf-b',
      wasActive: true
    })
  })

  it('sets the highlight without a reveal when the list mounts or reopens, then reveals the next change', () => {
    const hidden = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      active: false,
      focusedPaneKey: 'tab-2:leaf-b'
    })
    expect(hidden.memory.wasActive).toBe(false)

    const reopened = decideActivityFollow({
      ...hidden.memory,
      active: true,
      focusedPaneKey: 'tab-2:leaf-b',
      selectedPaneKey: null,
      focusedRowListed: true
    })
    expect(reopened.highlightPaneKey).toBe('tab-2:leaf-b')
    expect(reopened.reveal).toBe(false)
    expect(reopened.memory.wasActive).toBe(true)

    const nextChange = decideActivityFollow({
      ...reopened.memory,
      active: true,
      focusedPaneKey: 'tab-3:leaf-c',
      selectedPaneKey: 'tab-2:leaf-b',
      focusedRowListed: true
    })
    expect(nextChange.highlightPaneKey).toBe('tab-3:leaf-c')
    expect(nextChange.reveal).toBe(true)
  })

  it('leaves the highlight alone while the focused pane has no agent, then follows the next one', () => {
    const plainTab = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: null,
      selectedPaneKey: 'tab-3:leaf-c',
      previousSelectedPaneKey: 'tab-3:leaf-c',
      adoptedPaneKey: 'tab-1:leaf-a',
      followedPaneKey: 'tab-1:leaf-a'
    })
    expect(plainTab.highlightPaneKey).toBeNull()

    const backOnAgent = decideActivityFollow({
      ...plainTab.memory,
      active: true,
      focusedPaneKey: 'tab-1:leaf-a',
      selectedPaneKey: 'tab-3:leaf-c',
      focusedRowListed: true
    })
    expect(backOnAgent.highlightPaneKey).toBe('tab-1:leaf-a')
  })

  it('waits for the row of a pane that reported status before its row exists', () => {
    const early = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: 'tab-2:leaf-b',
      focusedRowListed: false
    })
    expect(early.highlightPaneKey).toBeNull()

    const listed = decideActivityFollow({
      ...early.memory,
      active: true,
      focusedPaneKey: 'tab-2:leaf-b',
      selectedPaneKey: null,
      focusedRowListed: true
    })
    expect(listed.highlightPaneKey).toBe('tab-2:leaf-b')
  })

  it('does nothing while the Activity list is not shown', () => {
    const decision = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      active: false,
      focusedPaneKey: 'tab-2:leaf-b',
      adoptedPaneKey: 'tab-2:leaf-b'
    })

    expect(decision.highlightPaneKey).toBeNull()
    expect(decision.reveal).toBe(false)
    expect(decision.memory.adoptedPaneKey).toBeNull()
  })

  it('lets an explicit selection keep the row while the focus it caused settles elsewhere', () => {
    const decision = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: 'tab-1:leaf-b',
      selectedPaneKey: 'tab-1:leaf-a',
      previousSelectedPaneKey: 'tab-2:leaf-c'
    })
    expect(decision.highlightPaneKey).toBeNull()

    const sameFocusLater = decideActivityFollow({
      ...decision.memory,
      active: true,
      focusedPaneKey: 'tab-1:leaf-b',
      selectedPaneKey: 'tab-1:leaf-a',
      focusedRowListed: true
    })
    expect(sameFocusLater.highlightPaneKey).toBeNull()

    const userMovesOn = decideActivityFollow({
      ...sameFocusLater.memory,
      active: true,
      focusedPaneKey: 'tab-1:leaf-d',
      selectedPaneKey: 'tab-1:leaf-a',
      focusedRowListed: true
    })
    expect(userMovesOn.highlightPaneKey).toBe('tab-1:leaf-d')
  })

  it('treats a selection of the row it followed earlier as explicit once that follow has landed', () => {
    const followed = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: 'tab-1:leaf-b',
      selectedPaneKey: null,
      focusedRowListed: true
    })
    expect(followed.highlightPaneKey).toBe('tab-1:leaf-b')
    const landed = decideActivityFollow({
      ...followed.memory,
      active: true,
      focusedPaneKey: 'tab-1:leaf-b',
      selectedPaneKey: 'tab-1:leaf-b',
      focusedRowListed: true
    })
    expect(landed.memory.followedPaneKey).toBeNull()

    const userClicksSameRowLater = decideActivityFollow({
      ...landed.memory,
      active: true,
      focusedPaneKey: 'tab-1:leaf-a',
      selectedPaneKey: 'tab-1:leaf-b',
      previousSelectedPaneKey: 'tab-3:leaf-c',
      focusedRowListed: true
    })
    expect(userClicksSameRowLater.highlightPaneKey).toBeNull()
  })

  it('does not take its own highlight for an explicit selection', () => {
    const decision = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: 'tab-4:leaf-z',
      selectedPaneKey: 'tab-2:leaf-b',
      previousSelectedPaneKey: 'tab-1:leaf-a',
      adoptedPaneKey: 'tab-2:leaf-b',
      followedPaneKey: 'tab-2:leaf-b'
    })

    expect(decision.highlightPaneKey).toBe('tab-4:leaf-z')
  })

  it('restores the highlight of the focused agent after the list reset it', () => {
    const decision = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: 'tab-2:leaf-b',
      selectedPaneKey: null,
      previousSelectedPaneKey: 'tab-9:leaf-x',
      adoptedPaneKey: 'tab-2:leaf-b'
    })

    expect(decision.highlightPaneKey).toBe('tab-2:leaf-b')
  })

  it('has nothing to do when the focused agent is already highlighted', () => {
    const decision = decideActivityFollow({
      ...NOTHING_FOLLOWED,
      focusedPaneKey: 'tab-2:leaf-b',
      selectedPaneKey: 'tab-2:leaf-b',
      previousSelectedPaneKey: 'tab-2:leaf-b'
    })

    expect(decision.highlightPaneKey).toBeNull()
    expect(decision.memory.adoptedPaneKey).toBe('tab-2:leaf-b')
  })
})

describe('findCollapsedGroupKeyHolding', () => {
  const groups: ActivityThreadGroup[] = [
    { key: 'working', label: 'Working', threads: [makeThread('tab-1:leaf-a')] },
    { key: 'done', label: 'Done', threads: [makeThread('tab-2:leaf-b')] }
  ]

  it('names the collapsed group that holds the row', () => {
    expect(findCollapsedGroupKeyHolding(groups, 'status', new Set(['done']), 'tab-2:leaf-b')).toBe(
      'done'
    )
  })

  it('names nothing when the group is open, the list is flat or the row is unknown', () => {
    const collapsed = new Set(['done'])
    expect(findCollapsedGroupKeyHolding(groups, 'status', collapsed, 'tab-1:leaf-a')).toBeNull()
    expect(findCollapsedGroupKeyHolding(groups, 'none', collapsed, 'tab-2:leaf-b')).toBeNull()
    expect(findCollapsedGroupKeyHolding(groups, 'status', collapsed, 'tab-9:leaf-x')).toBeNull()
  })
})

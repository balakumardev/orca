import { describe, expect, it } from 'vitest'
import { getActivityThreadTaskTitle } from './activity-thread-display'

<<<<<<< HEAD
describe('getActivityThreadTaskTitle', () => {
  const tab = {
    customTitle: null,
    generatedTitle: undefined,
    title: 'Claude',
    defaultTitle: 'Claude'
  }

  it('prefers a meaningful agent session title over the last prompt', () => {
    expect(
      getActivityThreadTaskTitle({
        entry: { prompt: 'ok go ahead', stateHistory: [], agentType: 'claude' },
        tab: { ...tab, title: '✳ Fix checkout race' },
        generatedTitlesEnabled: false
      })
    ).toBe('Fix checkout race')
    expect(
      getActivityThreadTaskTitle({
        entry: {
          prompt: 'Investigate the flaky login test',
          stateHistory: [],
          agentType: 'claude'
        },
        tab: { ...tab, title: '✳ Fix checkout race' },
        generatedTitlesEnabled: false
      })
    ).toBe('Fix checkout race')
  })

  it('keeps the prompt when the live tab title is only a default or status label', () => {
    for (const title of ['Claude', '✳ Claude Code', 'Terminal 2', '✳']) {
      expect(
        getActivityThreadTaskTitle({
          entry: {
            prompt: 'Investigate the flaky login test',
            stateHistory: [],
            agentType: 'claude'
          },
          tab: { ...tab, title },
          generatedTitlesEnabled: false
        })
      ).toBe('Investigate the flaky login test')
    }
    for (const title of ['✳ Claude Code', 'Gemini CLI ready']) {
      expect(
        getActivityThreadTaskTitle({
          entry: { prompt: 'Investigate the flaky login test', stateHistory: [] },
          tab: { ...tab, title },
          generatedTitlesEnabled: false
        })
      ).toBe('Investigate the flaky login test')
    }
  })

  it("does not fall back to a sibling pane's tab title for an unresolved split pane", () => {
    const splitTab = { ...tab, title: 'Build docs site' }
    expect(
      getActivityThreadTaskTitle({
        entry: { prompt: '', stateHistory: [] },
        tab: splitTab,
        generatedTitlesEnabled: false,
        paneLiveTitle: null
      })
    ).toBe('Claude')

    // A single-pane tab's title is the pane's own title, so it still applies.
    expect(
      getActivityThreadTaskTitle({
        entry: { prompt: '', stateHistory: [] },
        tab: splitTab,
        generatedTitlesEnabled: false
      })
    ).toBe('Build docs site')
||||||| c91a7a6ee3
=======
const resumedTab = {
  customTitle: null,
  aiVaultTitle: {
    agent: 'claude' as const,
    sessionId: 'session-1',
    title: 'Triage lead handover',
    kind: 'named' as const
  },
  generatedTitle: 'Mac restarted at 15 01 so this tab stopped',
  title: 'Triage lead handover',
  defaultTitle: 'Terminal 2'
}

const resumedEntry = {
  prompt: 'How is the rename going?',
  stateHistory: [],
  agentType: 'claude' as const,
  providerSession: { key: 'session_id' as const, id: 'session-1' }
}

describe('getActivityThreadTaskTitle', () => {
  it("names a resumed session by its own name, not the tab's first prompt", () => {
    expect(
      getActivityThreadTaskTitle({
        entry: resumedEntry,
        tab: resumedTab,
        generatedTitlesEnabled: true
      })
    ).toBe('Triage lead handover')
>>>>>>> f573753da681b2512379f3a1f6199af8be0cd921
  })
})

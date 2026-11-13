import { describe, expect, it } from 'vitest'
import { getActivityThreadTaskTitle } from './activity-thread-display'

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
  })
})

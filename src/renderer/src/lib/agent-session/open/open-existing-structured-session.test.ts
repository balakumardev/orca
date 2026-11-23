// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { openDesktopStructuredSessionInteraction } from './open-existing-structured-session'
import type { StructuredSessionOpenTab } from '../../../../../shared/agent-session/view/open-structured-agent-session'

describe('history open authority', () => {
  it('does not activate a refreshed chat after its recording host is retired', async () => {
    const refreshing = Promise.withResolvers<void>()
    const refreshed = Promise.withResolvers<void>()
    let current = true
    let tabs: StructuredSessionOpenTab[] = []
    let selected: string | null = null
    const opening = openDesktopStructuredSessionInteraction(
      { kind: 'history', structuredSession: { workspaceId: 'repo-1', sessionId: 'chat-1' } },
      {
        target: { kind: 'environment', environmentId: 'intbox' },
        current: () => current,
        deps: {
          tabs: () => tabs,
          refresh: async () => {
            refreshing.resolve()
            await refreshed.promise
          },
          activate: ({ sessionId }) => {
            selected = sessionId
            return true
          },
          reveal: async () => 'gone'
        },
        locate: async () => ({ reason: 'unsupported', beforeEffects: true }),
        present: () => {}
      }
    )
    await refreshing.promise
    current = false
    tabs = [{ id: 'remote-tab', sessionId: 'chat-1' }]
    refreshed.resolve()

    expect(await opening).toEqual({ kind: 'superseded' })
    expect(selected).toBeNull()
  })
})

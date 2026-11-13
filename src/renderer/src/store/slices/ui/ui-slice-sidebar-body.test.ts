import { describe, expect, it } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'

describe('toggleSidebarBody', () => {
  it('flips an open sidebar between Workspaces and Activity', () => {
    const store = createUIStore()
    store.setState({ sidebarOpen: true, sidebarBody: 'workspaces' })

    store.getState().toggleSidebarBody()
    expect(store.getState().sidebarBody).toBe('agents')
    expect(store.getState().sidebarOpen).toBe(true)

    store.getState().toggleSidebarBody()
    expect(store.getState().sidebarBody).toBe('workspaces')
  })

  it('opens a closed sidebar on Activity whichever body it last showed', () => {
    const store = createUIStore()
    for (const lastBody of ['workspaces', 'agents'] as const) {
      store.setState({ sidebarOpen: false, sidebarBody: lastBody })

      store.getState().toggleSidebarBody()

      expect(store.getState().sidebarOpen).toBe(true)
      expect(store.getState().sidebarBody).toBe('agents')
    }
  })
})

import { describe, expect, it } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'

describe('toggleActivityPane', () => {
  it('expands and collapses the Activity pane of an open sidebar without changing the workspace list', () => {
    const store = createUIStore()
    store.setState({ sidebarOpen: true, sidebarBody: 'workspaces', activityPaneOpen: true })

    store.getState().toggleActivityPane()
    expect(store.getState().activityPaneOpen).toBe(false)
    expect(store.getState().sidebarOpen).toBe(true)
    expect(store.getState().sidebarBody).toBe('workspaces')

    store.getState().toggleActivityPane()
    expect(store.getState().activityPaneOpen).toBe(true)
    expect(store.getState().sidebarBody).toBe('workspaces')
  })

  it('opens a closed sidebar with the pane expanded whichever state it was left in', () => {
    const store = createUIStore()
    for (const lastPaneState of [true, false]) {
      store.setState({ sidebarOpen: false, activityPaneOpen: lastPaneState })

      store.getState().toggleActivityPane()

      expect(store.getState().sidebarOpen).toBe(true)
      expect(store.getState().activityPaneOpen).toBe(true)
    }
  })
})

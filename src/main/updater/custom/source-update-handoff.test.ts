import { afterEach, describe, expect, it } from 'vitest'
import { runCancelableLocalPtySpawn } from '../../providers/local-pty/local-pty-spawn-state'
import { holdSourceUpdateSessionStarts } from './source-update-session-admission'
import {
  configureSourceUpdateHandoff,
  requestSourceUpdateQuit,
  SourceUpdateHandoff
} from './source-update-handoff'

function fixture() {
  const state: {
    blocker: string | null
    healthy: boolean
    checkpoint: 'saved' | 'failed'
    prepared: boolean
    startsHeld: boolean
    quit: boolean
    commit: (() => void) | undefined
  } = {
    blocker: null,
    healthy: true,
    checkpoint: 'saved',
    prepared: false,
    startsHeld: false,
    quit: false,
    commit: undefined
  }
  const deps = {
    pid: 4242,
    blockingReason: () => state.blocker,
    daemonHealthy: async () => state.healthy,
    prepareCheckpoint: async () => {
      if (state.checkpoint === 'failed') {
        return null
      }
      state.prepared = true
      return () => {
        state.prepared = false
      }
    },
    scheduleQuit: (commit: () => void) => {
      state.commit = commit
    },
    holdSessionStarts: () => {
      state.startsHeld = true
      return () => {
        state.startsHeld = false
      }
    },
    quit: () => {
      state.quit = true
    }
  }
  return { state, deps, handoff: new SourceUpdateHandoff(deps) }
}

describe('source update handoff', () => {
  afterEach(() => configureSourceUpdateHandoff(null))

  it('refuses local fallback starts during handoff and admits them again after cancellation', async () => {
    const release = holdSourceUpdateSessionStarts()
    try {
      await expect(runCancelableLocalPtySpawn('fallback', async () => 4242)).rejects.toThrow(
        'Orca is restarting for a source update'
      )
    } finally {
      release()
    }
    expect(await runCancelableLocalPtySpawn('fallback', async () => 4242)).toBe(4242)
  })

  it('refuses unconfigured apps and paired callers without scheduling a quit', async () => {
    expect((await requestSourceUpdateQuit({ kind: 'local-cli' })).state).toBe('unsupported')
    const { handoff, state } = fixture()
    configureSourceUpdateHandoff(handoff)
    for (const caller of [
      undefined,
      { kind: 'desktop' } as const,
      { kind: 'paired-device', deviceId: 'phone' } as const
    ]) {
      expect((await requestSourceUpdateQuit(caller)).state).toBe('unsupported')
    }
    expect(state.prepared).toBe(false)
    expect(state.commit).toBeUndefined()
    expect(await requestSourceUpdateQuit({ kind: 'local-cli' })).toEqual({
      state: 'quitting',
      pid: 4242
    })
  })

  it('acknowledges the checkpoint before the scheduled normal quit', async () => {
    const { handoff, state } = fixture()
    expect(await handoff.request()).toEqual({ state: 'quitting', pid: 4242 })
    expect(state.prepared).toBe(true)
    expect(state.quit).toBe(false)
    state.commit?.()
    expect(state.quit).toBe(true)
  })

  it('releases the checkpoint close hold before normal quit but fences new sessions until a veto', async () => {
    const { handoff, state, deps } = fixture()
    deps.quit = () => {
      expect(state.prepared).toBe(false)
      expect(state.startsHeld).toBe(true)
      state.quit = true
    }
    await handoff.request()
    state.commit?.()
    expect(state.quit).toBe(true)
    expect(state.startsHeld).toBe(true)
    expect((await handoff.request()).state).toBe('deferred')
    handoff.cancel()
    expect(state.startsHeld).toBe(false)
    expect((await handoff.request()).state).toBe('quitting')
  })

  it.each(['native-chat-busy', 'nonpersistent-terminal', 'already-quitting'])(
    'keeps the app running when %s blocks the handoff',
    async (blocker) => {
      const { handoff, state } = fixture()
      state.blocker = blocker
      expect(await handoff.request()).toEqual({ state: 'deferred', pid: 4242, reason: blocker })
      expect(state.prepared).toBe(false)
      expect(state.commit).toBeUndefined()
    }
  )

  it('defers when the daemon cannot be verified healthy', async () => {
    const { handoff, state } = fixture()
    state.healthy = false
    expect(await handoff.request()).toEqual({
      state: 'deferred',
      pid: 4242,
      reason: 'daemon-unavailable'
    })
    expect(state.prepared).toBe(false)
    expect(state.commit).toBeUndefined()
  })

  it('keeps the app running when the renderer cannot save its checkpoint', async () => {
    const { handoff, state } = fixture()
    state.checkpoint = 'failed'
    expect(await handoff.request()).toEqual({
      state: 'deferred',
      pid: 4242,
      reason: 'checkpoint-failed'
    })
    expect(state.commit).toBeUndefined()
  })

  it('rechecks sessions after asynchronous preparation and restores unload guards on refusal', async () => {
    const { handoff, state, deps } = fixture()
    const prepare = deps.prepareCheckpoint
    deps.prepareCheckpoint = async () => {
      const release = await prepare()
      state.blocker = 'native-chat-busy'
      return release
    }
    expect(await handoff.request()).toEqual({
      state: 'deferred',
      pid: 4242,
      reason: 'native-chat-busy'
    })
    expect(state.prepared).toBe(false)
    expect(state.commit).toBeUndefined()
  })

  it('cancels a scheduled quit if a nonpersistent session starts before commit', async () => {
    const { handoff, state } = fixture()
    await handoff.request()
    state.blocker = 'nonpersistent-terminal'
    state.commit?.()
    expect(state.quit).toBe(false)
    expect(state.prepared).toBe(false)
    state.blocker = null
    expect(await handoff.request()).toEqual({ state: 'quitting', pid: 4242 })
  })

  it('does not prepare a second handoff while the first owns the checkpoint', async () => {
    const { handoff, state } = fixture()
    const first = handoff.request()
    expect(await handoff.request()).toEqual({
      state: 'deferred',
      pid: 4242,
      reason: 'handoff-in-progress'
    })
    expect(await first).toEqual({ state: 'quitting', pid: 4242 })
    state.commit?.()
    expect(state.quit).toBe(true)
  })

  it('recovers preparation failures without leaving the handoff latched', async () => {
    const { handoff, state, deps } = fixture()
    const prepare = deps.prepareCheckpoint
    deps.prepareCheckpoint = async () => {
      throw new Error('renderer disconnected')
    }
    expect(await handoff.request()).toEqual({
      state: 'deferred',
      pid: 4242,
      reason: 'preparation-failed'
    })
    expect(state.quit).toBe(false)
    deps.prepareCheckpoint = prepare
    expect(await handoff.request()).toEqual({ state: 'quitting', pid: 4242 })
  })
})

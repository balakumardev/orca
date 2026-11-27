import { expect, it } from 'vitest'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import type { ProviderProcessSpawner } from '../../provider-process/provider-process-spawn'
import { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import { StructuredAgentSessionTaskQueue } from '../../native-chat/agent-session-wire/host/structured-agent-session-task-queue'
import { StructuredAgentSessionStartFlights } from '../../native-chat/agent-session-wire/startup/structured-agent-session-start-flight'
import { StructuredAgentSessionAdapterRouter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-router'
import { claudeAndCodexAgents } from '../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import { record } from '../../native-chat/agent-session-wire/recovery/testing/structured-agent-session-restart-resume.test-fixture'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { holdSourceUpdateSessionStarts } from './source-update-session-admission'
import { pending } from './source-update-chat-work'

it('keeps independent provider children busy after pipe closure and fences their actual spawn', async () => {
  const child = createFakeSpawnedChild(9_400_000)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real process ownership reads only the fixture's events, pid and streams.
  const spawnImpl = (() => child) as unknown as ProviderProcessSpawner
  const launch = () =>
    spawnManagedProviderProcess(
      { command: 'provider', args: [] },
      { site: 'source-update-test', platform: 'win32', allowHost: false, spawnImpl }
    )
  const release = holdSourceUpdateSessionStarts()
  try {
    expect(launch).toThrow('Orca is restarting for a source update')
  } finally {
    release()
  }
  const process = launch()
  try {
    expect(pending()).toBe(true)
    child.emit('close', null, null)
    expect(pending()).toBe(true)
  } finally {
    child.emit('exit', 0, null)
    await process.exitPromise
  }
  expect(pending()).toBe(false)
})

it('retains queued and cancelled-start work until the underlying operations settle', async () => {
  const queue = new StructuredAgentSessionTaskQueue()
  const flights = new StructuredAgentSessionStartFlights()
  const first = Promise.withResolvers<void>()
  const cancelledAttempt = Promise.withResolvers<void>()
  const queued = queue.serialize('chat', () => first.promise)
  const next = queue.serialize('chat', async () => {})
  flights.trackAttempt('chat', cancelledAttempt.promise)
  expect(pending()).toBe(true)
  first.resolve()
  await Promise.all([queued, next])
  // The logical flight has already gone, but its acquisition cleanup is still pending.
  expect(flights.has('chat')).toBe(false)
  expect(pending()).toBe(true)
  cancelledAttempt.resolve()
  await flights.attemptsEnded('chat')
  expect(pending()).toBe(false)
})

it('fences reused routers and retains acquisition ownership until release is acknowledged', async () => {
  const renaming = Promise.withResolvers<void>()
  const acquisition =
    Promise.withResolvers<Awaited<ReturnType<StructuredAgentSessionAdapter['acquire']>>>()
  const unused = (): never => {
    throw new Error('unexpected adapter operation')
  }
  const adapter: StructuredAgentSessionAdapter = {
    renameProviderSession: () => renaming.promise,
    acquire: () => acquisition.promise,
    hasOwnedAcquisition: () => true,
    releaseAcquisition: async () => true,
    open: unused,
    dispatch: unused,
    cancelTurn: unused,
    answerPrompt: unused,
    setOption: unused
  }
  const router = new StructuredAgentSessionAdapterRouter(
    claudeAndCodexAgents(adapter),
    async () => {}
  )
  const input = {
    identity: {
      sessionId: 'chat',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: null
    },
    fence: 1,
    spawnToken: 'start'
  }
  const release = holdSourceUpdateSessionStarts()
  const renameInput = { record: record(), providerSessionId: 'thread-1', name: 'New name' }
  try {
    await expect(router.acquire(input)).rejects.toThrow('Orca is restarting for a source update')
    await expect(router.renameProviderSession(renameInput)).rejects.toThrow(
      'Orca is restarting for a source update'
    )
    expect(router.hasPendingSessionOwnership()).toBe(false)
  } finally {
    release()
  }
  const rename = router.renameProviderSession(renameInput)
  try {
    // Preparation of an unloaded chat has no session route yet.
    expect(router.hasPendingSessionOwnership()).toBe(false)
    expect(pending()).toBe(true)
  } finally {
    renaming.resolve()
    await rename
  }
  expect(pending()).toBe(false)
  const starting = router.acquire(input)
  expect(router.hasPendingSessionOwnership()).toBe(true)
  expect(pending()).toBe(true)
  acquisition.resolve({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1000, spawnToken: 'start' },
    acquisitionGeneration: 'generation'
  })
  await starting
  expect(pending()).toBe(false)
  expect(router.hasPendingSessionOwnership()).toBe(true)
  await router.releaseAcquisition({ sessionId: 'chat' })
  expect(router.hasPendingSessionOwnership()).toBe(true)
  router.acknowledgeSessionRelease('chat')
  expect(router.hasPendingSessionOwnership()).toBe(false)
})

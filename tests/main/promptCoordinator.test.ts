import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptEvent } from '@shared/protocol'
import { EventBus } from '@main/eventBus'
import { PromptCoordinator, type PromptTransport } from '@main/promptCoordinator'
import { SessionStore } from '@main/sessions/sessionStore'
import { HistoryStore } from '@main/storage/history'

const directories: string[] = []

interface Harness {
  coordinator: PromptCoordinator
  sessions: SessionStore
  events: PromptEvent[]
  sessionId: string
}

async function createHarness(transport: PromptTransport): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'iroh-coordinator-'))
  directories.push(directory)
  const sessions = new SessionStore(new HistoryStore(join(directory, 'history')), {
    debounceMs: 5,
  })
  await sessions.initialize()

  const bus = new EventBus()
  const events: PromptEvent[] = []
  bus.onPromptEvent((event) => events.push(event))

  const coordinator = new PromptCoordinator({
    client: transport,
    sessions,
    bus,
    idFactory: () => 'request-1',
  })

  return {
    coordinator,
    sessions,
    events,
    sessionId: sessions.getActiveSessionId()!,
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
  )
})

describe('PromptCoordinator', () => {
  it('rejects a concurrent prompt with a busy error', async () => {
    let emit: ((event: PromptEvent) => void) | null = null
    const harness = await createHarness({
      streamPrompt: async (request) => {
        emit = request.emit
        await new Promise<void>(() => undefined)
      },
    })

    await harness.coordinator.sendPrompt({ sessionId: harness.sessionId, text: 'first' })
    await expect(
      harness.coordinator.sendPrompt({ sessionId: harness.sessionId, text: 'second' }),
    ).rejects.toMatchObject({ code: 'busy' })
    expect(harness.coordinator.isBusy()).toBe(true)

    emit!({ requestId: 'request-1', type: 'done', sessionId: harness.sessionId })
    await vi.waitFor(() => expect(harness.coordinator.isBusy()).toBe(false))
  })

  it('assembles deltas, completes the assistant message, and releases the lock', async () => {
    const streamPrompt = vi.fn(async (request: Parameters<PromptTransport['streamPrompt']>[0]) => {
      request.emit({ requestId: request.requestId, type: 'start', sessionId: request.sessionId })
      request.emit({ requestId: request.requestId, type: 'delta', content: 'Hel' })
      request.emit({ requestId: request.requestId, type: 'delta', content: 'lo' })
      request.emit({ requestId: request.requestId, type: 'done', sessionId: request.sessionId })
    })
    const harness = await createHarness({ streamPrompt })

    const result = await harness.coordinator.sendPrompt({
      sessionId: harness.sessionId,
      text: 'hi',
    })

    expect(result.requestId).toBe('request-1')
    await vi.waitFor(() => expect(harness.coordinator.isBusy()).toBe(false))

    const snapshot = await harness.sessions.getSnapshot(harness.sessionId)
    expect(snapshot.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(snapshot.messages[1]?.content).toBe('Hello')
    expect(snapshot.messages[1]?.status).toBe('complete')
    expect(harness.events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'done'])

    await harness.coordinator.sendPrompt({ sessionId: harness.sessionId, text: 'again' })
    expect(streamPrompt).toHaveBeenCalledTimes(2)
  })

  it('marks the request failed and releases the lock on a server error', async () => {
    const harness = await createHarness({
      streamPrompt: async (request) => {
        request.emit({ requestId: request.requestId, type: 'start', sessionId: request.sessionId })
        request.emit({ requestId: request.requestId, type: 'delta', content: 'partial' })
        request.emit({
          requestId: request.requestId,
          type: 'error',
          sessionId: request.sessionId,
          code: 'server',
          message: 'server exploded',
        })
      },
    })

    await harness.coordinator.sendPrompt({ sessionId: harness.sessionId, text: 'fail' })
    await vi.waitFor(() => expect(harness.coordinator.isBusy()).toBe(false))

    const snapshot = await harness.sessions.getSnapshot(harness.sessionId)
    const user = snapshot.messages.find((message) => message.role === 'user')
    const assistant = snapshot.messages.find((message) => message.role === 'assistant')
    expect(user?.status).toBe('failed')
    expect(assistant?.status).toBe('failed')
    expect(assistant?.content).toBe('partial')
    expect(harness.events.at(-1)).toMatchObject({
      type: 'error',
      code: 'server',
      message: 'server exploded',
    })
  })

  it('releases the lock when the transport throws before a terminal event', async () => {
    const harness = await createHarness({
      streamPrompt: async () => {
        throw new Error('connection closed')
      },
    })

    await harness.coordinator.sendPrompt({ sessionId: harness.sessionId, text: 'boom' })
    await vi.waitFor(() => expect(harness.coordinator.isBusy()).toBe(false))

    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toMatchObject({ type: 'error', code: 'connection-closed' })

    const snapshot = await harness.sessions.getSnapshot(harness.sessionId)
    expect(snapshot.messages.find((message) => message.role === 'user')?.status).toBe('failed')
  })

  it('reports only one terminal outcome and releases once', async () => {
    const harness = await createHarness({
      streamPrompt: async (request) => {
        request.emit({ requestId: request.requestId, type: 'start', sessionId: request.sessionId })
        request.emit({ requestId: request.requestId, type: 'done', sessionId: request.sessionId })
        throw new Error('late failure')
      },
    })

    await harness.coordinator.sendPrompt({ sessionId: harness.sessionId, text: 'hi' })
    await vi.waitFor(() => expect(harness.coordinator.isBusy()).toBe(false))

    expect(harness.events.map((event) => event.type)).toEqual(['start', 'done'])
    expect(harness.events.filter((event) => event.type === 'done')).toHaveLength(1)
  })

  it('rejects empty prompts and unknown sessions before opening a stream', async () => {
    const streamPrompt = vi.fn(async () => undefined)
    const harness = await createHarness({ streamPrompt })

    await expect(
      harness.coordinator.sendPrompt({ sessionId: harness.sessionId, text: '   ' }),
    ).rejects.toMatchObject({ code: 'configuration' })
    await expect(
      harness.coordinator.sendPrompt({ sessionId: 'missing', text: 'hello' }),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(streamPrompt).not.toHaveBeenCalled()
  })
})

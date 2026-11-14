import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PromptEvent } from '@shared/protocol'
import { EventBus } from '@main/eventBus'
import { IrohClient } from '@main/irohClient'
import { irohBindings } from '@main/irohBindings'
import { PromptCoordinator } from '@main/promptCoordinator'
import { SessionStore } from '@main/sessions/sessionStore'
import { HistoryStore } from '@main/storage/history'
import { readPromptLine, startMockServer, writeLine, writeRaw } from './mockServer'

let iroh: typeof import('@number0/iroh') | null = null
try {
  iroh = await import('@number0/iroh')
} catch (error) {
  console.warn(
    'Skipping Iroh integration tests: the native @number0/iroh module is unavailable.',
    error,
  )
}

const describeIntegration = iroh ? describe : describe.skip

function createClient(ticket: string): IrohClient {
  return new IrohClient({
    secretKeyBytes: Uint8Array.from(iroh!.SecretKey.generate().toBytes()),
    bindings: irohBindings,
    getConfig: () => ({ serverTicket: ticket, serverNodeId: null, relayUrl: null }),
    connectTimeoutMs: 15_000,
  })
}

describeIntegration('Iroh transport integration', () => {
  it('sends the exact prompt line and receives start, deltas, and done', async () => {
    let received = ''
    const server = await startMockServer(iroh!, async (stream) => {
      received = await readPromptLine(stream)
      await writeLine(stream, { type: 'start', session_id: 'session-1' })
      await writeLine(stream, { type: 'delta', content: 'Hel' })
      await writeLine(stream, { type: 'delta', content: 'lo' })
      await writeLine(stream, { type: 'done' })
      await stream.send.finish()
    })

    const client = createClient(server.ticket)
    try {
      const status = await client.connect()
      expect(status).toMatchObject({ state: 'connected' })

      const events: PromptEvent[] = []
      await client.streamPrompt({
        requestId: 'request-1',
        sessionId: 'session-1',
        text: 'hello',
        emit: (event) => events.push(event),
      })

      expect(received).toBe('{"type":"prompt","session_id":"session-1","text":"hello"}\n')
      expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'done'])
      expect(
        events
          .filter((event): event is Extract<PromptEvent, { type: 'delta' }> => event.type === 'delta')
          .map((event) => event.content)
          .join(''),
      ).toBe('Hello')
    } finally {
      await client.close()
      await server.close()
    }
  })

  async function runCoordinatedPrompt(
    handler: (stream: import('@number0/iroh').BiStream, sessionId: string) => Promise<void>,
  ): Promise<PromptEvent[]> {
    const directory = await mkdtemp(join(tmpdir(), 'iroh-integration-'))
    const sessions = new SessionStore(new HistoryStore(join(directory, 'history')), {
      debounceMs: 5,
    })
    await sessions.initialize()
    const sessionId = sessions.getActiveSessionId()!

    const server = await startMockServer(iroh!, async (stream) => handler(stream, sessionId))
    const bus = new EventBus()
    const events: PromptEvent[] = []
    bus.onPromptEvent((event) => events.push(event))

    const client = createClient(server.ticket)
    const coordinator = new PromptCoordinator({
      client,
      sessions,
      bus,
      idFactory: () => 'request-1',
    })

    try {
      const status = await client.connect()
      expect(status.state).toBe('connected')

      await coordinator.sendPrompt({ sessionId, text: 'hello' })
      await vi.waitFor(() => expect(coordinator.isBusy()).toBe(false), { timeout: 20_000 })

      const snapshot = await sessions.getSnapshot(sessionId)
      expect(snapshot.messages.some((message) => message.role === 'user')).toBe(true)
      return events
    } finally {
      await client.close()
      await server.close()
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    }
  }

  it('passes through a server error frame and releases the prompt lock', async () => {
    const events = await runCoordinatedPrompt(async (stream, sessionId) => {
      await readPromptLine(stream)
      await writeLine(stream, { type: 'start', session_id: sessionId })
      await writeLine(stream, { type: 'error', message: 'the agent is busy' })
      await stream.send.finish()
    })

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'server',
      message: 'the agent is busy',
    })
  })

  it('reports an early close with the allowlist hint and releases the prompt lock', async () => {
    const events = await runCoordinatedPrompt(async (stream) => {
      await readPromptLine(stream)
      await stream.send.finish()
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'connection-closed' })
    expect((events[0] as Extract<PromptEvent, { type: 'error' }>).message).toContain('/iroh_allow')
  })

  it('terminates the request on a malformed JSON line and releases the prompt lock', async () => {
    const events = await runCoordinatedPrompt(async (stream) => {
      await readPromptLine(stream)
      await writeRaw(stream, 'this is not json\n')
      await stream.send.finish()
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'protocol' })
  })
})

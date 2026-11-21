import { describe, expect, it, vi } from 'vitest'
import type { ClientConfig, ConnectionStatus, PromptEvent } from '@shared/protocol'
import {
  ALPN_BYTES,
  IrohClient,
  type BiStreamLike,
  type ConnectionLike,
  type EndpointBindings,
  type EndpointLike,
  type RecvStreamLike,
} from '@main/irohClient'
import { serializePrompt } from '@main/protocol'

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (error: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

class FakeRecvStream implements RecvStreamLike {
  readonly stop = vi.fn(async () => undefined)

  constructor(private readonly readImpl: () => Promise<ArrayLike<number>>) {}

  read(_sizeLimit: number): Promise<ArrayLike<number>> {
    return this.readImpl()
  }
}

class FakeBiStream implements BiStreamLike {
  readonly chunks: Uint8Array[]
  readonly written: number[] = []
  readonly finish = vi.fn(async () => undefined)
  readonly read = vi.fn(async () => {
    const chunk = this.chunks.shift()
    return chunk ? Array.from(chunk) : []
  })
  readonly recv: RecvStreamLike
  readonly send = {
    writeAll: vi.fn(async (bytes: number[]) => {
      this.written.push(...bytes)
    }),
    finish: this.finish,
  }

  constructor(chunks: Uint8Array[] = [], recv?: RecvStreamLike) {
    this.chunks = chunks
    this.recv = recv ?? new FakeRecvStream(() => this.read())
  }
}

class FakeConnection implements ConnectionLike {
  readonly close = vi.fn()
  readonly closedDeferred = new Deferred<string>()
  readonly openBi = vi.fn(async () => this.stream)

  constructor(private readonly stream: BiStreamLike = new FakeBiStream()) {}

  closed(): Promise<string> {
    return this.closedDeferred.promise
  }
}

interface BindingsHarness {
  endpoint: {
    connect: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    isClosed: ReturnType<typeof vi.fn>
  }
  bindings: EndpointBindings
}

function createBindings(): BindingsHarness {
  const endpoint = {
    connect: vi.fn(async (_addr: unknown, _alpn: number[]) => new FakeConnection() as ConnectionLike),
    close: vi.fn(async () => undefined),
    isClosed: vi.fn(() => false),
  }

  return {
    endpoint,
    bindings: {
      bindEndpoint: vi.fn(async () => endpoint as unknown as EndpointLike),
      ticketToAddr: vi.fn((ticket: string) => ({ kind: 'ticket', ticket })),
      nodeIdToAddr: vi.fn((nodeId: string, relayUrl: string | null) => ({
        kind: 'node',
        nodeId,
        relayUrl,
      })),
      relayMode: vi.fn((relayUrl: string | null) => ({ relayUrl })),
    },
  }
}

const ticketConfig: ClientConfig = {
  serverTicket: 'ticket-1',
  serverNodeId: null,
  relayUrl: null,
}

function createClient(options: {
  config?: ClientConfig
  connectTimeoutMs?: number
} = {}): {
  client: IrohClient
  harness: BindingsHarness
  statuses: ConnectionStatus[]
  setConfig: (config: ClientConfig) => void
} {
  const harness = createBindings()
  let config = options.config ?? ticketConfig
  const statuses: ConnectionStatus[] = []
  const client = new IrohClient({
    secretKeyBytes: new Uint8Array(32).fill(9),
    bindings: harness.bindings,
    getConfig: () => config,
    onStatus: (status) => statuses.push(status),
    connectTimeoutMs: options.connectTimeoutMs ?? 30_000,
  })

  return {
    client,
    harness,
    statuses,
    setConfig: (next) => {
      config = next
    },
  }
}

async function connectedWithStream(stream: FakeBiStream): Promise<{
  client: IrohClient
  connection: FakeConnection
  harness: BindingsHarness
}> {
  const { client, harness } = createClient()
  const connection = new FakeConnection(stream)
  harness.endpoint.connect.mockResolvedValue(connection)
  await client.connect()
  return { client, connection, harness }
}

describe('IrohClient connection lifecycle', () => {
  it('binds with the persisted key and the exact ALPN', async () => {
    const { client, harness, statuses } = createClient()
    const connection = new FakeConnection()
    harness.endpoint.connect.mockResolvedValue(connection)

    const status = await client.connect()

    expect(status.state).toBe('connected')
    expect(harness.bindings.bindEndpoint).toHaveBeenCalledTimes(1)
    const [options, relayMode] = (harness.bindings.bindEndpoint as ReturnType<typeof vi.fn>).mock
      .calls[0] as [{ secretKey: number[]; alpns: number[][] }, { relayUrl: string | null }]

    expect(options.secretKey).toEqual(Array(32).fill(9))
    expect(new TextDecoder().decode(Uint8Array.from(options.alpns[0]))).toBe('iroh-channel/1')
    expect(options.alpns[0]).toEqual(ALPN_BYTES)
    expect(relayMode).toEqual({ relayUrl: null })
    expect(statuses.map((entry) => entry.state)).toEqual(['connecting', 'connected'])
  })

  it('uses a custom relay when configured', async () => {
    const { client, harness } = createClient({
      config: { ...ticketConfig, relayUrl: 'https://relay.example' },
    })
    harness.endpoint.connect.mockResolvedValue(new FakeConnection())

    await client.connect()

    expect(harness.bindings.relayMode).toHaveBeenCalledWith('https://relay.example')
  })

  it('resolves a ticket target directly', async () => {
    const { client, harness } = createClient()
    harness.endpoint.connect.mockResolvedValue(new FakeConnection())

    await client.connect()

    expect(harness.bindings.ticketToAddr).toHaveBeenCalledWith('ticket-1')
    expect(harness.endpoint.connect).toHaveBeenCalledWith({ kind: 'ticket', ticket: 'ticket-1' }, ALPN_BYTES)
  })

  it('resolves a bare NodeId with the configured relay hint', async () => {
    const { client, harness } = createClient({
      config: {
        serverTicket: null,
        serverNodeId: 'node-id-base32',
        relayUrl: 'https://relay.example',
      },
    })
    harness.endpoint.connect.mockResolvedValue(new FakeConnection())

    await client.connect()

    expect(harness.bindings.nodeIdToAddr).toHaveBeenCalledWith(
      'node-id-base32',
      'https://relay.example',
    )
    expect(harness.endpoint.connect).toHaveBeenCalledWith(
      { kind: 'node', nodeId: 'node-id-base32', relayUrl: 'https://relay.example' },
      ALPN_BYTES,
    )
  })

  it('fails with a timeout and an error status', async () => {
    const { client, harness, statuses } = createClient({ connectTimeoutMs: 20 })
    harness.endpoint.connect.mockReturnValue(new Promise(() => undefined))

    const status = await client.connect()

    expect(status.state).toBe('error')
    expect(status.message).toMatch(/did not respond|timed out/i)
    expect(statuses.map((entry) => entry.state)).toEqual(['connecting', 'error'])
  })

  it('closes a connection that resolves after the timeout', async () => {
    const { client, harness } = createClient({ connectTimeoutMs: 20 })
    const late = new Deferred<ConnectionLike>()
    harness.endpoint.connect.mockReturnValue(late.promise)

    const status = await client.connect()
    expect(status.state).toBe('error')

    const connection = new FakeConnection()
    late.resolve(connection)
    await vi.waitFor(() => expect(connection.close).toHaveBeenCalled())
  })

  it('deduplicates concurrent connection attempts and reuses the connection', async () => {
    const { client, harness } = createClient()
    const deferred = new Deferred<ConnectionLike>()
    harness.endpoint.connect.mockReturnValue(deferred.promise)
    const connection = new FakeConnection()

    const first = client.ensureConnection()
    const second = client.ensureConnection()
    deferred.resolve(connection)

    expect(await first).toBe(connection)
    expect(await second).toBe(connection)
    expect(harness.endpoint.connect).toHaveBeenCalledTimes(1)

    expect(await client.ensureConnection()).toBe(connection)
    expect(harness.endpoint.connect).toHaveBeenCalledTimes(1)
  })

  it('drops a closed connection and reconnects on the next prompt', async () => {
    const { client, harness } = createClient()
    const first = new FakeConnection()
    const second = new FakeConnection()
    harness.endpoint.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    expect(await client.ensureConnection()).toBe(first)
    first.closedDeferred.resolve('closed')

    await vi.waitFor(() => expect(client.getStatus().state).toBe('disconnected'))
    expect(await client.ensureConnection()).toBe(second)
    expect(harness.endpoint.connect).toHaveBeenCalledTimes(2)
  })

  it('closes the connection and endpoint on disconnect', async () => {
    const { client, harness } = createClient()
    const connection = new FakeConnection()
    harness.endpoint.connect.mockResolvedValue(connection)
    await client.connect()

    await client.disconnect()

    expect(connection.close).toHaveBeenCalled()
    expect(harness.endpoint.close).toHaveBeenCalled()
    expect(client.getStatus().state).toBe('disconnected')
  })

  it('refuses to reconnect after shutdown', async () => {
    const { client, harness } = createClient()
    harness.endpoint.connect.mockResolvedValue(new FakeConnection())
    await client.connect()
    await client.close()

    await expect(client.ensureConnection()).rejects.toMatchObject({ code: 'connection-closed' })
  })

  it('rejects an invalid configured target before connecting', async () => {
    const { client, harness } = createClient({ config: { ...ticketConfig } })
    ;(harness.bindings.ticketToAddr as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('invalid ticket')
    })

    const status = await client.connect()

    expect(status.state).toBe('error')
    expect(status.message).toMatch(/invalid/i)
    expect(harness.endpoint.connect).not.toHaveBeenCalled()
  })
})

describe('IrohClient prompt streaming', () => {
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

  async function stream(
    chunks: Uint8Array[],
  ): Promise<{ events: PromptEvent[]; stream: FakeBiStream }> {
    const biStream = new FakeBiStream(chunks)
    const { client } = await connectedWithStream(biStream)
    const events: PromptEvent[] = []

    await client.streamPrompt({
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'hello',
      emit: (event) => events.push(event),
    })

    return { events, stream: biStream }
  }

  it('writes exactly one prompt line and finishes the send side once', async () => {
    const { events, stream: biStream } = await stream([
      encode('{"type":"start","session_id":"session-1"}\n{"type":"delta","content":"Hel'),
      encode('lo"}\n{"type":"done"}\n'),
    ])

    const expected = serializePrompt('session-1', 'hello')
    expect(Array.from(Uint8Array.from(biStream.written))).toEqual(
      Array.from(new TextEncoder().encode(expected)),
    )
    expect(biStream.finish).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'done'])
    expect(
      events
        .filter((event): event is Extract<PromptEvent, { type: 'delta' }> => event.type === 'delta')
        .map((event) => event.content)
        .join(''),
    ).toBe('Hello')
    expect(biStream.recv.stop).toBeDefined()
    expect(biStream.recv.stop).toHaveBeenCalledTimes(1)
  })

  it('surfaces a server error message', async () => {
    const { events } = await stream([
      encode('{"type":"start","session_id":"session-1"}\n{"type":"error","message":"model overloaded"}\n'),
    ])

    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    expect(events[1]).toMatchObject({ code: 'server', message: 'model overloaded' })
  })

  it('reports an early EOF with the allowlist hint', async () => {
    const { events } = await stream([])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'connection-closed' })
    expect((events[0] as Extract<PromptEvent, { type: 'error' }>).message).toContain('/iroh_allow')
  })

  it('fails the request on malformed JSON', async () => {
    const { events, stream: biStream } = await stream([encode('not-json\n')])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'protocol' })
    expect(biStream.recv.stop).toHaveBeenCalled()
  })

  it('ignores unknown frame types and stops reading after a terminal frame', async () => {
    const { events, stream: biStream } = await stream([
      encode(
        '{"type":"start","session_id":"session-1"}\n{"type":"heartbeat"}\n{"type":"delta","content":"ok"}\n{"type":"done"}\n',
      ),
    ])

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'done'])
    expect(biStream.read).toHaveBeenCalledTimes(1)
  })

  it('abandons a stream that opens after the request was aborted', async () => {
    const biStream = new FakeBiStream()
    const { client, connection } = await connectedWithStream(biStream)
    const opened = new Deferred<BiStreamLike>()
    connection.openBi.mockReturnValue(opened.promise)
    const controller = new AbortController()
    const events: PromptEvent[] = []

    const streaming = client.streamPrompt({
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'hello',
      emit: (event) => events.push(event),
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(connection.openBi).toHaveBeenCalled())
    controller.abort()
    opened.resolve(biStream)
    await streaming

    expect(events).toEqual([])
    expect(biStream.send.writeAll).not.toHaveBeenCalled()
    expect(biStream.recv.stop).toHaveBeenCalledTimes(1)
  })

  it('stops a pending read and emits no error when aborted during streaming', async () => {
    let resolveRead: ((value: ArrayLike<number>) => void) | null = null
    let readStarted = false
    const stop = vi.fn(async () => {
      resolveRead?.([])
    })
    const recv: RecvStreamLike = {
      read: () => {
        readStarted = true
        return new Promise<ArrayLike<number>>((resolve) => {
          resolveRead = resolve
        })
      },
      stop,
    }
    const biStream = new FakeBiStream([], recv)
    const { client } = await connectedWithStream(biStream)
    const controller = new AbortController()
    const events: PromptEvent[] = []

    const streaming = client.streamPrompt({
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'hello',
      emit: (event) => events.push(event),
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(readStarted).toBe(true))
    controller.abort()
    await streaming

    expect(events).toEqual([])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('maps a read failure to a terminal error', async () => {
    const biStream = new FakeBiStream()
    biStream.read.mockRejectedValue(new Error('connection reset by peer'))
    const { client } = await connectedWithStream(biStream)
    const events: PromptEvent[] = []

    await client.streamPrompt({
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'hello',
      emit: (event) => events.push(event),
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'connection-refused' })
  })
})

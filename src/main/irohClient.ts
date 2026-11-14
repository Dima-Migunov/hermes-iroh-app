import type { ClientConfig, ConnectionStatus, PromptEvent } from '@shared/protocol'
import { AppError, errorMessage, mapIrohError } from './errors'
import { LineDecoder } from './lineDecoder'
import { parseServerFrame, PromptStateMachine, serializePrompt } from './protocol'

export const ALPN_PROTOCOL = 'iroh-channel/1'
export const ALPN_BYTES = Array.from(new TextEncoder().encode(ALPN_PROTOCOL))
export const CONNECT_TIMEOUT_MS = 30_000
export const READ_CHUNK_BYTES = 64 * 1024

export type RemoteAddrLike = unknown
export type RelayModeLike = unknown

export interface SendStreamLike {
  writeAll(bytes: number[]): Promise<void>
  finish(): Promise<void>
}

export interface RecvStreamLike {
  read(sizeLimit: number): Promise<ArrayLike<number>>
  stop?(errorCode: bigint): Promise<void>
}

export interface BiStreamLike {
  send: SendStreamLike
  recv: RecvStreamLike
}

export interface ConnectionLike {
  openBi(): Promise<BiStreamLike>
  closed(): Promise<string>
  close?(errorCode: bigint, reason: number[]): void
}

export interface EndpointLike {
  connect(addr: RemoteAddrLike, alpn: number[]): Promise<ConnectionLike>
  close(): Promise<void>
  isClosed?(): boolean
}

export interface EndpointBindings {
  bindEndpoint(
    options: { secretKey: number[]; alpns: number[][] },
    relayMode: RelayModeLike,
  ): Promise<EndpointLike>
  ticketToAddr(ticket: string): RemoteAddrLike
  nodeIdToAddr(nodeId: string, relayUrl: string | null): RemoteAddrLike
  relayMode(relayUrl: string | null): RelayModeLike
}

export interface PromptStreamRequest {
  requestId: string
  sessionId: string
  text: string
  emit: (event: PromptEvent) => void
}

export interface IrohClientOptions {
  secretKeyBytes: Uint8Array
  bindings: EndpointBindings
  getConfig: () => ClientConfig
  onStatus?: (status: ConnectionStatus) => void
  connectTimeoutMs?: number
}

export class IrohClient {
  private readonly secretKeyBytes: Uint8Array
  private readonly bindings: EndpointBindings
  private readonly getConfig: () => ClientConfig
  private readonly onStatus?: (status: ConnectionStatus) => void
  private readonly connectTimeoutMs: number

  private status: ConnectionStatus = { state: 'disconnected' }
  private endpoint: EndpointLike | null = null
  private endpointPromise: Promise<EndpointLike> | null = null
  private connection: ConnectionLike | null = null
  private connectionPromise: Promise<ConnectionLike> | null = null
  private shuttingDown = false

  constructor(options: IrohClientOptions) {
    this.secretKeyBytes = options.secretKeyBytes
    this.bindings = options.bindings
    this.getConfig = options.getConfig
    this.onStatus = options.onStatus
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  }

  getStatus(): ConnectionStatus {
    return { ...this.status }
  }

  async connect(): Promise<ConnectionStatus> {
    this.shuttingDown = false
    try {
      await this.ensureConnection()
    } catch {
      // The status already carries the mapped failure.
    }
    return this.getStatus()
  }

  async ensureConnection(): Promise<ConnectionLike> {
    if (this.connection) return this.connection
    if (this.connectionPromise) return this.connectionPromise

    this.connectionPromise = this.establishConnection()
    try {
      return await this.connectionPromise
    } finally {
      this.connectionPromise = null
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection
    this.connection = null
    if (connection) this.closeConnection(connection)

    const pendingEndpoint = this.endpointPromise
    if (pendingEndpoint) {
      const lateEndpoint = await pendingEndpoint.catch(() => null)
      if (lateEndpoint) await lateEndpoint.close().catch(() => undefined)
    }
    this.endpointPromise = null

    const endpoint = this.endpoint
    this.endpoint = null
    if (endpoint) await endpoint.close().catch(() => undefined)

    this.setStatus({ state: 'disconnected' })
  }

  async close(): Promise<void> {
    this.shuttingDown = true
    await this.disconnect()
  }

  async streamPrompt(request: PromptStreamRequest): Promise<void> {
    const machine = new PromptStateMachine(request.requestId, request.sessionId, request.emit)
    let stream: BiStreamLike | null = null

    try {
      const connection = await this.ensureConnection()
      stream = await connection.openBi()

      const line = serializePrompt(request.sessionId, request.text)
      await stream.send.writeAll(Array.from(new TextEncoder().encode(line)))
      await stream.send.finish()

      const decoder = new LineDecoder()
      while (!machine.isSettled) {
        const chunk = await stream.recv.read(READ_CHUNK_BYTES)
        const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk)

        if (bytes.length === 0) {
          this.forwardLines(decoder.end(), machine)
          break
        }

        this.forwardLines(decoder.push(bytes), machine)
      }

      if (!machine.isSettled) machine.handleEof()
    } catch (error) {
      machine.handleTransportError(error)
    } finally {
      if (stream?.recv.stop) {
        try {
          await stream.recv.stop(0n)
        } catch {
          // The peer may already have closed the stream.
        }
      }
    }
  }

  private async establishConnection(): Promise<ConnectionLike> {
    if (this.shuttingDown) {
      throw new AppError('connection-closed', 'The Iroh endpoint has been shut down.')
    }

    this.setStatus({ state: 'connecting' })

    try {
      const endpoint = await this.getEndpoint()
      const address = this.resolveTarget()
      const connection = await this.connectWithTimeout(endpoint, address)

      this.connection = connection
      this.watchConnection(connection)
      this.setStatus({ state: 'connected' })
      return connection
    } catch (error) {
      const mapped = mapIrohError(error)
      this.setStatus({ state: 'error', message: mapped.message })
      throw mapped
    }
  }

  private async getEndpoint(): Promise<EndpointLike> {
    if (this.endpoint && !(this.endpoint.isClosed?.() ?? false)) return this.endpoint
    if (this.endpointPromise) return this.endpointPromise

    const config = this.getConfig()
    const relayMode = this.bindings.relayMode(config.relayUrl)
    const promise = this.bindings
      .bindEndpoint(
        {
          secretKey: Array.from(this.secretKeyBytes),
          alpns: [ALPN_BYTES],
        },
        relayMode,
      )
      .then((endpoint) => {
        this.endpoint = endpoint
        return endpoint
      })

    this.endpointPromise = promise
    try {
      return await promise
    } finally {
      this.endpointPromise = null
    }
  }

  private resolveTarget(): RemoteAddrLike {
    const config = this.getConfig()
    try {
      if (config.serverTicket) return this.bindings.ticketToAddr(config.serverTicket)
      if (config.serverNodeId) {
        return this.bindings.nodeIdToAddr(config.serverNodeId, config.relayUrl)
      }
    } catch (error) {
      throw new AppError(
        'configuration',
        `The configured server target is invalid. Check the ticket or NodeId in settings. (${errorMessage(error)})`,
        { cause: error },
      )
    }

    throw new AppError(
      'configuration',
      'No server target is configured. Save an endpoint ticket or a server NodeId in settings.',
    )
  }

  private async connectWithTimeout(
    endpoint: EndpointLike,
    address: RemoteAddrLike,
  ): Promise<ConnectionLike> {
    const attempt = endpoint.connect(address, ALPN_BYTES)
    let timedOut = false
    let timer: NodeJS.Timeout | undefined

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new AppError('timeout', 'The connection attempt timed out.'))
      }, this.connectTimeoutMs)
    })

    try {
      return await Promise.race([attempt, timeout])
    } catch (error) {
      if (timedOut) {
        void attempt.then((connection) => this.closeConnection(connection)).catch(() => undefined)
        throw new AppError(
          'timeout',
          `The server did not respond within ${Math.round(this.connectTimeoutMs / 1000)} seconds. Check the server ticket or NodeId, the relay URL, and that the server is online.`,
        )
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private watchConnection(connection: ConnectionLike): void {
    void connection
      .closed()
      .then(() => {
        if (this.connection !== connection) return
        this.connection = null
        this.setStatus({ state: 'disconnected' })
      })
      .catch((error: unknown) => {
        if (this.connection !== connection) return
        this.connection = null
        this.setStatus({ state: 'error', message: mapIrohError(error).message })
      })
  }

  private closeConnection(connection: ConnectionLike): void {
    try {
      connection.close?.(0n, [])
    } catch {
      // Already closed.
    }
  }

  private forwardLines(lines: string[], machine: PromptStateMachine): void {
    for (const line of lines) {
      if (machine.isSettled) return
      const frame = parseServerFrame(line)
      if (frame) machine.handleFrame(frame)
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status.state === status.state && this.status.message === status.message) return
    this.status = status
    this.onStatus?.(this.getStatus())
  }
}

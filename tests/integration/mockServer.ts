import type * as Iroh from '@number0/iroh'

export const TEST_ALPN = Array.from(new TextEncoder().encode('iroh-channel/1'))

export interface IrohModule {
  Endpoint: typeof import('@number0/iroh').Endpoint
  SecretKey: typeof import('@number0/iroh').SecretKey
  EndpointTicket: typeof import('@number0/iroh').EndpointTicket
  presetMinimal: typeof import('@number0/iroh').presetMinimal
}

export interface MockServer {
  ticket: string
  done: Promise<void>
  close(): Promise<void>
}

export async function startMockServer(
  iroh: IrohModule,
  handler: (stream: Iroh.BiStream, connection: Iroh.Connection) => Promise<void>,
): Promise<MockServer> {
  const builder = iroh.Endpoint.builder()
  iroh.presetMinimal(builder)
  builder.secretKey(Array.from(iroh.SecretKey.generate().toBytes()))
  builder.alpns([TEST_ALPN])
  builder.bindAddr('127.0.0.1:0')

  const endpoint = await builder.bind()
  const ticket = iroh.EndpointTicket.fromAddr(endpoint.addr()).toString()

  const done = (async () => {
    const incoming = await endpoint.acceptNext()
    if (!incoming) return
    const accepting = await incoming.accept()
    const connection = await accepting.connect()
    const stream = await connection.acceptBi()
    await handler(stream, connection)
  })()

  return {
    ticket,
    done,
    close: async () => {
      await endpoint.close().catch(() => undefined)
      await done.catch(() => undefined)
    },
  }
}

export async function readPromptLine(stream: Iroh.BiStream): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  while (!buffer.includes('\n')) {
    const chunk = await stream.recv.read(64 * 1024)
    if (chunk.length === 0) break
    buffer += decoder.decode(Uint8Array.from(chunk), { stream: true })
  }

  return buffer
}

export async function writeLine(
  stream: Iroh.BiStream,
  frame: Record<string, unknown>,
): Promise<void> {
  const line = `${JSON.stringify(frame)}\n`
  await stream.send.writeAll(Array.from(new TextEncoder().encode(line)))
}

export async function writeRaw(stream: Iroh.BiStream, text: string): Promise<void> {
  await stream.send.writeAll(Array.from(new TextEncoder().encode(text)))
}

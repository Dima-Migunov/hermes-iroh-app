import { describe, expect, it } from 'vitest'
import type { PromptEvent, ResponseMetadata } from '@shared/protocol'
import { AppError } from '@main/errors'
import { parseServerFrame, PromptStateMachine, serializePrompt } from '@main/protocol'

const metadata: ResponseMetadata = {
  schema: 1,
  generated_at: '2026-11-21T12:00:00.000Z',
  latency_ms: 812,
  model: 'gpt-5.1',
  provider: 'openai',
  usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
  session_usage: { total_tokens: 12600, api_calls: 8, context_percent: 6.6 },
  balance: { remaining_usd: 12.5, paid_access: true, as_of_ms: 1763726400000 },
}

describe('serializePrompt', () => {
  it('produces the exact protocol line', () => {
    expect(serializePrompt('s1', 'hello')).toBe(
      '{"type":"prompt","session_id":"s1","text":"hello"}\n',
    )
  })

  it('escapes special characters and emits exactly one trailing newline', () => {
    const line = serializePrompt('session"1', 'line 1\nline "2"\\')

    expect(line.endsWith('\n')).toBe(true)
    expect(line.indexOf('\n')).toBe(line.length - 1)
    expect(JSON.parse(line)).toEqual({
      type: 'prompt',
      session_id: 'session"1',
      text: 'line 1\nline "2"\\',
    })
  })
})

describe('parseServerFrame', () => {
  it('parses all documented frames', () => {
    expect(parseServerFrame('{"type":"start","session_id":"s1"}')).toEqual({
      type: 'start',
      session_id: 's1',
    })
    expect(parseServerFrame('{"type":"delta","content":"a"}')).toEqual({
      type: 'delta',
      content: 'a',
    })
    expect(parseServerFrame('{"type":"done"}')).toEqual({ type: 'done' })
    expect(parseServerFrame('{"type":"error","message":"nope"}')).toEqual({
      type: 'error',
      message: 'nope',
    })
  })

  it('attaches normalized metadata to a done frame', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'done', metadata }))).toEqual({
      type: 'done',
      metadata,
    })
  })

  it('drops invalid metadata and keeps a bare done frame', () => {
    expect(parseServerFrame('{"type":"done","metadata":{"schema":1}}')).toEqual({ type: 'done' })
    expect(parseServerFrame('{"type":"done","metadata":"invalid"}')).toEqual({ type: 'done' })
    expect(parseServerFrame('{"type":"done","metadata":null}')).toEqual({ type: 'done' })
  })

  it('ignores metadata on an error frame', () => {
    expect(
      parseServerFrame(JSON.stringify({ type: 'error', message: 'nope', metadata })),
    ).toEqual({ type: 'error', message: 'nope' })
  })

  it('ignores unknown frame types', () => {
    expect(parseServerFrame('{"type":"heartbeat"}')).toBeNull()
  })

  it('rejects malformed JSON', () => {
    expect(() => parseServerFrame('not json')).toThrowError(AppError)
  })

  it('rejects recognized frames with missing fields', () => {
    expect(() => parseServerFrame('{"type":"start"}')).toThrowError(/session_id/)
    expect(() => parseServerFrame('{"type":"delta","content":5}')).toThrowError(/content/)
    expect(() => parseServerFrame('{"type":"error"}')).toThrowError(/message/)
    expect(() => parseServerFrame('{"kind":"done"}')).toThrowError(/type/)
  })
})

describe('PromptStateMachine', () => {
  const collect = (): {
    machine: PromptStateMachine
    events: PromptEvent[]
  } => {
    const events: PromptEvent[] = []
    return {
      events,
      machine: new PromptStateMachine('req-1', 'session-1', (event) => events.push(event)),
    }
  }

  it('emits start, deltas, and one done in order', () => {
    const { machine, events } = collect()

    machine.handleFrame({ type: 'start', session_id: 'session-1' })
    machine.handleFrame({ type: 'delta', content: 'a' })
    machine.handleFrame({ type: 'delta', content: 'b' })
    machine.handleFrame({ type: 'done' })
    machine.handleFrame({ type: 'delta', content: 'ignored' })
    machine.handleFrame({ type: 'done' })

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'done'])
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
    expect(machine.isSettled).toBe(true)
  })

  it('rejects a delta before start', () => {
    const { machine, events } = collect()
    machine.handleFrame({ type: 'delta', content: 'early' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'protocol' })
    expect(machine.isSettled).toBe(true)
  })

  it('rejects a mismatched session id', () => {
    const { machine, events } = collect()
    machine.handleFrame({ type: 'start', session_id: 'other' })

    expect(events[0]).toMatchObject({ type: 'error', code: 'protocol' })
    expect((events[0] as Extract<PromptEvent, { type: 'error' }>).message).toContain('other')
  })

  it('rejects a duplicate start frame', () => {
    const { machine, events } = collect()
    machine.handleFrame({ type: 'start', session_id: 'session-1' })
    machine.handleFrame({ type: 'start', session_id: 'session-1' })

    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    expect(events[1]).toMatchObject({ code: 'protocol' })
  })

  it('preserves a server error message and ignores later frames', () => {
    const { machine, events } = collect()
    machine.handleFrame({ type: 'start', session_id: 'session-1' })
    machine.handleFrame({ type: 'error', message: 'model overloaded' })
    machine.handleFrame({ type: 'delta', content: 'ignored' })

    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    expect(events[1]).toMatchObject({ code: 'server', message: 'model overloaded' })
  })

  it('reports EOF as a connection-closed error with the allowlist hint', () => {
    const { machine, events } = collect()
    machine.handleEof()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'connection-closed' })
    expect((events[0] as Extract<PromptEvent, { type: 'error' }>).message).toContain('/iroh_allow')
  })

  it('ignores transport failures after a terminal event', () => {
    const { machine, events } = collect()
    machine.handleFrame({ type: 'start', session_id: 'session-1' })
    machine.handleFrame({ type: 'done' })
    machine.handleTransportError(new Error('stream closed'))

    expect(events.map((event) => event.type)).toEqual(['start', 'done'])
  })

  it('forwards metadata exactly once and ignores later frames', () => {
    const { machine, events } = collect()
    machine.handleFrame({ type: 'start', session_id: 'session-1' })
    machine.handleFrame({ type: 'done', metadata })
    machine.handleFrame({ type: 'done', metadata: { ...metadata, schema: 2 } })
    machine.handleTransportError(new Error('late failure'))

    const doneEvents = events.filter((event) => event.type === 'done')
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0]).toMatchObject({ type: 'done', metadata })
    expect(events.map((event) => event.type)).toEqual(['start', 'done'])
    expect(machine.isSettled).toBe(true)
  })

  it('emits a bare done without a metadata property when none was sent', () => {
    const { machine, events } = collect()
    machine.handleFrame({ type: 'start', session_id: 'session-1' })
    machine.handleFrame({ type: 'done' })

    expect(events[1]).toEqual({
      requestId: 'req-1',
      type: 'done',
      sessionId: 'session-1',
    })
  })
})

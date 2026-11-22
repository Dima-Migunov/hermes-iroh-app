import type { ClientPromptFrame, ErrorCode, PromptEvent, ServerFrame } from '@shared/protocol'
import { normalizeResponseMetadata } from '@shared/metadata'
import { AppError, earlyCloseMessage, mapIrohError } from './errors'

export function serializePrompt(sessionId: string, text: string): string {
  const frame: ClientPromptFrame = {
    type: 'prompt',
    session_id: sessionId,
    text,
  }
  return `${JSON.stringify(frame)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseServerFrame(line: string): ServerFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new AppError('protocol', 'The server sent a response line that is not valid JSON.')
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new AppError('protocol', 'The server sent a response frame without a valid type.')
  }

  switch (parsed.type) {
    case 'start':
      if (typeof parsed.session_id !== 'string') {
        throw new AppError('protocol', 'The server start frame is missing a valid session_id.')
      }
      return { type: 'start', session_id: parsed.session_id }
    case 'delta':
      if (typeof parsed.content !== 'string') {
        throw new AppError('protocol', 'The server delta frame is missing valid content.')
      }
      return { type: 'delta', content: parsed.content }
    case 'done': {
      const metadata = normalizeResponseMetadata(parsed.metadata)
      return metadata ? { type: 'done', metadata } : { type: 'done' }
    }
    case 'error':
      if (typeof parsed.message !== 'string') {
        throw new AppError('protocol', 'The server error frame is missing a valid message.')
      }
      return { type: 'error', message: parsed.message }
    default:
      return null
  }
}

export class PromptStateMachine {
  private started = false
  private terminal = false

  constructor(
    private readonly requestId: string,
    private readonly expectedSessionId: string,
    private readonly emit: (event: PromptEvent) => void,
  ) {}

  get isSettled(): boolean {
    return this.terminal
  }

  handleFrame(frame: ServerFrame): void {
    if (this.terminal) return

    switch (frame.type) {
      case 'start':
        if (this.started) {
          this.fail('protocol', 'The server sent more than one start frame.')
          return
        }
        if (frame.session_id !== this.expectedSessionId) {
          this.fail(
            'protocol',
            `The server responded for session "${frame.session_id}" instead of "${this.expectedSessionId}".`,
          )
          return
        }
        this.started = true
        this.emit({ requestId: this.requestId, type: 'start', sessionId: frame.session_id })
        return
      case 'delta':
        if (!this.started) {
          this.fail('protocol', 'The server sent response content before the start frame.')
          return
        }
        this.emit({ requestId: this.requestId, type: 'delta', content: frame.content })
        return
      case 'done':
        this.terminal = true
        this.emit({
          requestId: this.requestId,
          type: 'done',
          sessionId: this.expectedSessionId,
          ...(frame.metadata ? { metadata: frame.metadata } : {}),
        })
        return
      case 'error':
        this.terminal = true
        this.emit({
          requestId: this.requestId,
          type: 'error',
          sessionId: this.expectedSessionId,
          code: 'server',
          message: frame.message,
        })
        return
    }
  }

  handleEof(): void {
    if (this.terminal) return
    this.fail('connection-closed', earlyCloseMessage())
  }

  handleTransportError(error: unknown): void {
    if (this.terminal) return
    const mapped = mapIrohError(error, { closedBeforeResponse: !this.started })
    this.fail(mapped.code, mapped.message)
  }

  private fail(code: ErrorCode, message: string): void {
    this.terminal = true
    this.emit({
      requestId: this.requestId,
      type: 'error',
      sessionId: this.expectedSessionId,
      code,
      message,
    })
  }
}

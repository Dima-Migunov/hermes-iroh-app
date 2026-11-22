import { randomUUID } from 'node:crypto'
import type { PromptEvent } from '@shared/protocol'
import type { PromptSubmission, PromptSubmissionResult } from '@shared/ipc'
import { AppError, mapIrohError } from './errors'
import type { PromptStreamRequest } from './irohClient'
import type { SessionStore } from './sessions/sessionStore'
import type { EventBus } from './eventBus'

export interface PromptTransport {
  streamPrompt(request: PromptStreamRequest): Promise<void>
}

export interface PromptCoordinatorDeps {
  client: PromptTransport
  sessions: SessionStore
  bus: EventBus
  idFactory?: () => string
}

export interface ActiveRequest {
  requestId: string
  sessionId: string
}

interface TrackedRequest extends ActiveRequest {
  assistantMessageId: string | null
  cancelled: boolean
  controller: AbortController
}

export class PromptCoordinator {
  private readonly client: PromptTransport
  private readonly sessions: SessionStore
  private readonly bus: EventBus
  private readonly idFactory: () => string
  private active: TrackedRequest | null = null

  constructor(deps: PromptCoordinatorDeps) {
    this.client = deps.client
    this.sessions = deps.sessions
    this.bus = deps.bus
    this.idFactory = deps.idFactory ?? randomUUID
  }

  isBusy(): boolean {
    return this.active !== null
  }

  getActiveRequest(): ActiveRequest | null {
    if (!this.active) return null
    return { requestId: this.active.requestId, sessionId: this.active.sessionId }
  }

  async sendPrompt(input: PromptSubmission): Promise<PromptSubmissionResult> {
    if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0) {
      throw new AppError('configuration', 'A session must be selected before sending a prompt.')
    }
    if (typeof input.text !== 'string' || input.text.trim().length === 0) {
      throw new AppError('configuration', 'The prompt is empty.')
    }
    if (this.active) {
      throw new AppError('busy', 'A response is already in progress.')
    }
    if (!this.sessions.hasSession(input.sessionId)) {
      throw new AppError('not-found', `Session "${input.sessionId}" does not exist.`)
    }

    const request: TrackedRequest = {
      requestId: this.idFactory(),
      sessionId: input.sessionId,
      assistantMessageId: null,
      cancelled: false,
      controller: new AbortController(),
    }
    this.active = request

    try {
      await this.sessions.appendUserMessage(request.sessionId, input.text)
    } catch (error) {
      this.active = null
      throw error
    }

    let terminalPromise: Promise<void> | null = null

    const release = (): void => {
      if (this.active === request) this.active = null
    }

    const emit = (event: PromptEvent): void => {
      if (request.cancelled) return

      if (event.type === 'start') {
        if (request.assistantMessageId === null) {
          request.assistantMessageId = this.sessions.beginAssistantMessage(event.sessionId).id
        }
        this.bus.emitPromptEvent(event)
        return
      }

      if (event.type === 'delta') {
        if (request.assistantMessageId) {
          this.sessions.appendDelta(request.sessionId, request.assistantMessageId, event.content)
        }
        this.bus.emitPromptEvent(event)
        return
      }

      if (event.type === 'cancelled') return

      release()
      this.bus.emitPromptEvent(event)
      terminalPromise = this.finish(event, request.assistantMessageId)
    }

    void this.run(request, input.text, emit, () => terminalPromise).catch(() => undefined)

    return { requestId: request.requestId }
  }

  async cancelPrompt(): Promise<boolean> {
    const request = this.active
    if (!request) return false

    request.cancelled = true
    this.active = null
    request.controller.abort()

    this.bus.emitPromptEvent({
      requestId: request.requestId,
      type: 'cancelled',
      sessionId: request.sessionId,
    })

    try {
      await this.sessions.interruptAssistant(request.sessionId, request.assistantMessageId)
    } catch {
      // Persistence failures must not turn a successful cancellation into an error.
    }

    return true
  }

  async shutdown(): Promise<void> {
    await this.sessions.flushAll()
  }

  private async run(
    request: TrackedRequest,
    text: string,
    emit: (event: PromptEvent) => void,
    getTerminalPromise: () => Promise<void> | null,
  ): Promise<void> {
    try {
      await this.client.streamPrompt({
        requestId: request.requestId,
        sessionId: request.sessionId,
        text,
        emit,
        signal: request.controller.signal,
      })
    } catch (error) {
      if (!request.cancelled && this.active === request) {
        const mapped = mapIrohError(error)
        emit({
          requestId: request.requestId,
          type: 'error',
          sessionId: request.sessionId,
          code: mapped.code,
          message: mapped.message,
        })
      }
    }

    if (!request.cancelled && this.active === request) {
      emit({
        requestId: request.requestId,
        type: 'error',
        sessionId: request.sessionId,
        code: 'internal',
        message: 'The prompt ended without a terminal response from the server.',
      })
    }

    const terminal = getTerminalPromise()
    if (terminal) await terminal
    await this.sessions.flush(request.sessionId).catch(() => undefined)
  }

  private async finish(
    event: Extract<PromptEvent, { type: 'done' | 'error' }>,
    assistantMessageId: string | null,
  ): Promise<void> {
    try {
      if (event.type === 'done') {
        if (assistantMessageId) {
          await this.sessions.completeAssistant(
            event.sessionId,
            assistantMessageId,
            event.metadata,
          )
        }
      } else {
        await this.sessions.failRequest(event.sessionId, assistantMessageId, {
          code: event.code,
          message: event.message,
        })
      }
      await this.sessions.flush(event.sessionId)
    } catch {
      // Persistence failures must not crash the main process or block new prompts.
    }
  }
}

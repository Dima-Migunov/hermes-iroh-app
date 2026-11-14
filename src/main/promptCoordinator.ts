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

export class PromptCoordinator {
  private readonly client: PromptTransport
  private readonly sessions: SessionStore
  private readonly bus: EventBus
  private readonly idFactory: () => string
  private active: ActiveRequest | null = null

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
    return this.active ? { ...this.active } : null
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

    const requestId = this.idFactory()
    const sessionId = input.sessionId
    this.active = { requestId, sessionId }

    try {
      await this.sessions.appendUserMessage(sessionId, input.text)
    } catch (error) {
      this.active = null
      throw error
    }

    let assistantMessageId: string | null = null
    let terminalPromise: Promise<void> | null = null

    const release = (): void => {
      if (this.active?.requestId === requestId) this.active = null
    }

    const emit = (event: PromptEvent): void => {
      if (event.type === 'start') {
        if (assistantMessageId === null) {
          assistantMessageId = this.sessions.beginAssistantMessage(event.sessionId).id
        }
        this.bus.emitPromptEvent(event)
        return
      }

      if (event.type === 'delta') {
        if (assistantMessageId) {
          this.sessions.appendDelta(sessionId, assistantMessageId, event.content)
        }
        this.bus.emitPromptEvent(event)
        return
      }

      release()
      this.bus.emitPromptEvent(event)
      terminalPromise = this.finish(event, assistantMessageId)
    }

    void this.run({
      requestId,
      sessionId,
      text: input.text,
      emit,
      getAssistantMessageId: () => assistantMessageId,
      getTerminalPromise: () => terminalPromise,
    }).catch(() => undefined)

    return { requestId }
  }

  async shutdown(): Promise<void> {
    await this.sessions.flushAll()
  }

  private async run(options: {
    requestId: string
    sessionId: string
    text: string
    emit: (event: PromptEvent) => void
    getAssistantMessageId: () => string | null
    getTerminalPromise: () => Promise<void> | null
  }): Promise<void> {
    try {
      await this.client.streamPrompt({
        requestId: options.requestId,
        sessionId: options.sessionId,
        text: options.text,
        emit: options.emit,
      })
    } catch (error) {
      if (this.active?.requestId === options.requestId) {
        const mapped = mapIrohError(error)
        options.emit({
          requestId: options.requestId,
          type: 'error',
          sessionId: options.sessionId,
          code: mapped.code,
          message: mapped.message,
        })
      }
    }

    if (this.active?.requestId === options.requestId) {
      options.emit({
        requestId: options.requestId,
        type: 'error',
        sessionId: options.sessionId,
        code: 'internal',
        message: 'The prompt ended without a terminal response from the server.',
      })
    }

    const terminal = options.getTerminalPromise()
    if (terminal) await terminal
    await this.sessions.flush(options.sessionId).catch(() => undefined)
  }

  private async finish(
    event: Extract<PromptEvent, { type: 'done' | 'error' }>,
    assistantMessageId: string | null,
  ): Promise<void> {
    try {
      if (event.type === 'done') {
        if (assistantMessageId) {
          await this.sessions.completeAssistant(event.sessionId, assistantMessageId)
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

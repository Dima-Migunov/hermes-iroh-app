import { randomUUID } from 'node:crypto'
import type {
  ErrorCode,
  ResponseMetadata,
  SessionSnapshot,
  SessionSummary,
  StoredMessage,
} from '@shared/protocol'
import type { HistoryIndex, HistoryStore } from '../storage/history'
import { AppError } from '../errors'

export interface SessionStoreOptions {
  now?: () => Date
  debounceMs?: number
  idFactory?: () => string
}

export type SessionsChangedListener = (sessions: SessionSummary[]) => void

const FALLBACK_TITLE = 'New chat'
const TITLE_LIMIT = 60

export class SessionStore {
  private readonly history: HistoryStore
  private readonly now: () => Date
  private readonly debounceMs: number
  private readonly idFactory: () => string
  private readonly listeners = new Set<SessionsChangedListener>()
  private readonly messagesBySession = new Map<string, StoredMessage[]>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  private readonly warnings: string[] = []
  private index: HistoryIndex = { activeSessionId: null, sessions: [] }

  constructor(history: HistoryStore, options: SessionStoreOptions = {}) {
    this.history = history
    this.now = options.now ?? (() => new Date())
    this.debounceMs = options.debounceMs ?? 250
    this.idFactory = options.idFactory ?? randomUUID
  }

  async initialize(): Promise<void> {
    const loaded = await this.history.loadIndex()
    if (loaded.warning) this.warnings.push(loaded.warning)
    this.index = loaded.index

    if (this.index.sessions.length === 0) {
      const session = this.buildSession()
      this.index.sessions.push(session)
      this.index.activeSessionId = session.id
      this.messagesBySession.set(session.id, [])
      await this.history.saveSession(session.id, [])
      await this.history.saveIndex(this.index)
    }

    if (
      this.index.activeSessionId === null ||
      !this.index.sessions.some((session) => session.id === this.index.activeSessionId)
    ) {
      this.index.activeSessionId = this.index.sessions[0]?.id ?? null
    }

    if (this.index.activeSessionId) {
      await this.loadSession(this.index.activeSessionId)
    }

    await this.history.saveIndex(this.index)
  }

  getWarnings(): string[] {
    return [...this.warnings]
  }

  onDidChange(listener: SessionsChangedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): SessionSummary[] {
    return [...this.index.sessions].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  getActiveSessionId(): string | null {
    return this.index.activeSessionId
  }

  hasSession(sessionId: string): boolean {
    return this.index.sessions.some((session) => session.id === sessionId)
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId)
    await this.loadSession(sessionId)
    return {
      session: { ...session },
      messages: (this.messagesBySession.get(sessionId) ?? []).map((message) => ({ ...message })),
    }
  }

  async getActiveSnapshot(): Promise<SessionSnapshot> {
    const sessionId = this.index.activeSessionId
    if (!sessionId) throw new AppError('not-found', 'No active session is available.')
    return this.getSnapshot(sessionId)
  }

  async create(): Promise<SessionSummary> {
    const session = this.buildSession()
    this.index.sessions.push(session)
    this.index.activeSessionId = session.id
    this.messagesBySession.set(session.id, [])
    await this.history.saveSession(session.id, [])
    await this.history.saveIndex(this.index)
    this.notify()
    return { ...session }
  }

  async activate(sessionId: string): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId)
    await this.loadSession(sessionId)
    this.index.activeSessionId = sessionId
    await this.history.saveIndex(this.index)
    this.notify()
    return {
      session: { ...session },
      messages: (this.messagesBySession.get(sessionId) ?? []).map((message) => ({ ...message })),
    }
  }

  async appendUserMessage(sessionId: string, text: string): Promise<StoredMessage> {
    const session = this.requireSession(sessionId)
    await this.loadSession(sessionId)
    const messages = this.messagesBySession.get(sessionId) ?? []
    const isFirstUserMessage = !messages.some((message) => message.role === 'user')

    const message: StoredMessage = {
      id: this.idFactory(),
      role: 'user',
      content: text,
      createdAt: this.now().toISOString(),
      status: 'complete',
    }
    messages.push(message)

    if (isFirstUserMessage) session.title = deriveTitle(text)
    session.updatedAt = message.createdAt

    await this.history.saveSession(sessionId, messages)
    await this.history.saveIndex(this.index)
    this.notify()
    return { ...message }
  }

  beginAssistantMessage(sessionId: string): StoredMessage {
    const session = this.requireSession(sessionId)
    const messages = this.messagesBySession.get(sessionId) ?? []
    const message: StoredMessage = {
      id: this.idFactory(),
      role: 'assistant',
      content: '',
      createdAt: this.now().toISOString(),
      status: 'streaming',
    }
    messages.push(message)
    this.messagesBySession.set(sessionId, messages)
    session.updatedAt = message.createdAt
    this.scheduleSave(sessionId)
    return { ...message }
  }

  appendDelta(sessionId: string, messageId: string, content: string): void {
    const messages = this.messagesBySession.get(sessionId)
    if (!messages) return
    const message = messages.find((candidate) => candidate.id === messageId)
    if (!message) return

    message.content += content
    const session = this.index.sessions.find((candidate) => candidate.id === sessionId)
    if (session) session.updatedAt = this.now().toISOString()
    this.scheduleSave(sessionId)
  }

  async completeAssistant(
    sessionId: string,
    messageId: string,
    metadata?: ResponseMetadata,
  ): Promise<void> {
    const messages = this.messagesBySession.get(sessionId)
    const message = messages?.find((candidate) => candidate.id === messageId)
    if (message) {
      message.status = 'complete'
      if (metadata) message.metadata = metadata
      const session = this.index.sessions.find((candidate) => candidate.id === sessionId)
      if (session) session.updatedAt = this.now().toISOString()
    }
    await this.flush(sessionId)
    this.notify()
  }

  async interruptAssistant(sessionId: string, messageId: string | null): Promise<void> {
    const messages = this.messagesBySession.get(sessionId)
    const message = messageId
      ? messages?.find((candidate) => candidate.id === messageId)
      : undefined
    if (message) {
      message.status = 'interrupted'
      const session = this.index.sessions.find((candidate) => candidate.id === sessionId)
      if (session) session.updatedAt = this.now().toISOString()
    }
    await this.flush(sessionId)
    this.notify()
  }

  async failRequest(
    sessionId: string,
    assistantMessageId: string | null,
    error: { code: ErrorCode; message: string },
  ): Promise<void> {
    const messages = this.messagesBySession.get(sessionId)
    if (messages) {
      if (assistantMessageId) {
        const assistant = messages.find((candidate) => candidate.id === assistantMessageId)
        if (assistant) {
          assistant.status = 'failed'
          assistant.error = { code: error.code, message: error.message }
        }
      }

      const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')
      if (lastUserMessage) {
        lastUserMessage.status = 'failed'
        lastUserMessage.error = { code: error.code, message: error.message }
      }
    }

    await this.flush(sessionId)
    this.notify()
  }

  async flush(sessionId: string): Promise<void> {
    const timer = this.saveTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.saveTimers.delete(sessionId)
    }
    const messages = this.messagesBySession.get(sessionId)
    if (messages) await this.history.saveSession(sessionId, messages)
    await this.history.saveIndex(this.index)
    await this.history.flush()
  }

  async flushAll(): Promise<void> {
    const sessionIds = [...this.saveTimers.keys()]
    for (const sessionId of sessionIds) {
      const timer = this.saveTimers.get(sessionId)
      if (timer) clearTimeout(timer)
      this.saveTimers.delete(sessionId)
      const messages = this.messagesBySession.get(sessionId)
      if (messages) await this.history.saveSession(sessionId, messages)
    }
    await this.history.saveIndex(this.index)
    await this.history.flush()
  }

  private buildSession(): SessionSummary {
    const timestamp = this.now().toISOString()
    return {
      id: this.idFactory(),
      title: FALLBACK_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  private requireSession(sessionId: string): SessionSummary {
    const session = this.index.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new AppError('not-found', `Session "${sessionId}" does not exist.`)
    return session
  }

  private async loadSession(sessionId: string): Promise<void> {
    if (this.messagesBySession.has(sessionId)) return

    const loaded = await this.history.loadSession(sessionId)
    if (loaded.warning) this.warnings.push(loaded.warning)

    let recovered = false
    const messages = loaded.messages.map((message) => {
      if (message.status !== 'streaming') return message
      recovered = true
      return { ...message, status: 'interrupted' as const }
    })

    this.messagesBySession.set(sessionId, messages)
    if (recovered) await this.history.saveSession(sessionId, messages)
  }

  private scheduleSave(sessionId: string): void {
    const existing = this.saveTimers.get(sessionId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.saveTimers.delete(sessionId)
      const messages = this.messagesBySession.get(sessionId)
      if (messages) {
        void this.history.saveSession(sessionId, messages).catch(() => undefined)
      }
    }, this.debounceMs)
    timer.unref?.()
    this.saveTimers.set(sessionId, timer)
  }

  private notify(): void {
    const sessions = this.list()
    for (const listener of this.listeners) listener(sessions)
  }
}

export function deriveTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return FALLBACK_TITLE
  if (normalized.length <= TITLE_LIMIT) return normalized
  return `${normalized.slice(0, TITLE_LIMIT - 1)}…`
}

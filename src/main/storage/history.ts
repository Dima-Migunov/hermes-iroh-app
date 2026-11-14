import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionSummary, StoredMessage } from '@shared/protocol'
import { writeFileAtomic } from './atomicFile'
import { errorMessage } from '../errors'

export interface HistoryIndex {
  activeSessionId: string | null
  sessions: SessionSummary[]
}

export interface IndexLoadResult {
  index: HistoryIndex
  warning?: string
}

export interface SessionLoadResult {
  messages: StoredMessage[]
  warning?: string
}

interface IndexDocument extends HistoryIndex {
  version: 1
}

interface SessionDocument {
  version: 1
  sessionId: string
  messages: StoredMessage[]
}

export class HistoryStore {
  private readonly historyDir: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(historyDir: string) {
    this.historyDir = historyDir
  }

  get indexPath(): string {
    return join(this.historyDir, 'index.json')
  }

  sessionPath(sessionId: string): string {
    return join(this.historyDir, `${sessionId}.json`)
  }

  async loadIndex(): Promise<IndexLoadResult> {
    let raw: string
    try {
      raw = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return { index: emptyIndex() }
      return {
        index: emptyIndex(),
        warning: `Chat history could not be loaded: ${errorMessage(error)}`,
      }
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The history index is not an object.')
      }
      const document = parsed as Record<string, unknown>
      const sessions = Array.isArray(document.sessions)
        ? document.sessions.filter(isSessionSummary).map((session) => ({ ...session }))
        : []
      const activeSessionId =
        typeof document.activeSessionId === 'string' &&
        sessions.some((session) => session.id === document.activeSessionId)
          ? document.activeSessionId
          : (sessions[0]?.id ?? null)

      return { index: { activeSessionId, sessions } }
    } catch (error) {
      await preserveCorruptFile(this.indexPath)
      return {
        index: emptyIndex(),
        warning: `Chat history index was invalid and has been reset. The original file was preserved. (${errorMessage(error)})`,
      }
    }
  }

  async saveIndex(index: HistoryIndex): Promise<void> {
    const document: IndexDocument = {
      version: 1,
      activeSessionId: index.activeSessionId,
      sessions: index.sessions,
    }
    await this.enqueue('index', () =>
      writeFileAtomic(this.indexPath, `${JSON.stringify(document, null, 2)}\n`),
    )
  }

  async loadSession(sessionId: string): Promise<SessionLoadResult> {
    const filePath = this.sessionPath(sessionId)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return { messages: [] }
      return {
        messages: [],
        warning: `Chat history for a session could not be loaded: ${errorMessage(error)}`,
      }
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The session document is not an object.')
      }
      const messages = (parsed as Record<string, unknown>).messages
      if (!Array.isArray(messages) || !messages.every(isStoredMessage)) {
        throw new Error('The session document has invalid messages.')
      }
      return { messages: messages.map((message) => ({ ...message })) }
    } catch (error) {
      await preserveCorruptFile(filePath)
      return {
        messages: [],
        warning: `Chat history for a session was invalid and has been reset. The original file was preserved. (${errorMessage(error)})`,
      }
    }
  }

  async saveSession(sessionId: string, messages: StoredMessage[]): Promise<void> {
    const document: SessionDocument = {
      version: 1,
      sessionId,
      messages,
    }
    await this.enqueue(sessionId, () =>
      writeFileAtomic(this.sessionPath(sessionId), `${JSON.stringify(document, null, 2)}\n`),
    )
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()])
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }
}

function emptyIndex(): HistoryIndex {
  return { activeSessionId: null, sessions: [] }
}

async function preserveCorruptFile(filePath: string): Promise<void> {
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '')
  await rename(filePath, `${filePath}.corrupt-${suffix}`).catch(() => undefined)
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  )
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    (record.role === 'user' || record.role === 'assistant') &&
    typeof record.content === 'string' &&
    typeof record.createdAt === 'string' &&
    (record.status === 'complete' ||
      record.status === 'streaming' ||
      record.status === 'failed' ||
      record.status === 'interrupted')
  )
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

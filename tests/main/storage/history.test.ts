import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/protocol'
import { HistoryStore } from '@main/storage/history'
import { SessionStore } from '@main/sessions/sessionStore'

const directories: string[] = []

interface Harness {
  historyDir: string
  history: HistoryStore
  store: SessionStore
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'iroh-history-'))
  directories.push(directory)
  const historyDir = join(directory, 'history')
  const history = new HistoryStore(historyDir)
  let sequence = 0
  let tick = 0
  const store = new SessionStore(history, {
    debounceMs: 5,
    idFactory: () => `id-${++sequence}`,
    now: () => new Date(Date.UTC(2026, 0, 1) + ++tick * 1000),
  })
  await store.initialize()
  return { historyDir, history, store }
}

async function reopen(historyDir: string): Promise<SessionStore> {
  const store = new SessionStore(new HistoryStore(historyDir), { debounceMs: 5 })
  await store.initialize()
  return store
}

function message(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: '',
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    status: 'streaming',
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
  )
})

describe('SessionStore', () => {
  it('creates one default empty session on first launch', async () => {
    const { store } = await createHarness()

    const sessions = store.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('New chat')
    expect(store.getActiveSessionId()).toBe(sessions[0].id)
    expect((await store.getActiveSnapshot()).messages).toEqual([])
  })

  it('restores the active session and its messages after restart', async () => {
    const { store, historyDir } = await createHarness()
    const activeId = store.getActiveSessionId()
    expect(activeId).not.toBeNull()
    await store.appendUserMessage(activeId!, 'hello there')

    const reopened = await reopen(historyDir)

    expect(reopened.getActiveSessionId()).toBe(activeId)
    const snapshot = await reopened.getActiveSnapshot()
    expect(snapshot.messages.map((entry) => entry.content)).toEqual(['hello there'])
  })

  it('isolates messages between sessions', async () => {
    const { store } = await createHarness()
    const firstId = store.getActiveSessionId()!
    const second = await store.create()

    await store.appendUserMessage(second.id, 'session B')
    await store.appendUserMessage(firstId, 'session A')

    expect((await store.getSnapshot(firstId)).messages.map((entry) => entry.content)).toEqual([
      'session A',
    ])
    expect((await store.getSnapshot(second.id)).messages.map((entry) => entry.content)).toEqual([
      'session B',
    ])
  })

  it('derives a normalized title from the first user message', async () => {
    const { store } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    await store.appendUserMessage(sessionId, '  hello   world  ')

    expect(store.list().find((session) => session.id === sessionId)?.title).toBe('hello world')
  })

  it('truncates long titles and keeps a fallback for empty sessions', async () => {
    const { store } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    await store.appendUserMessage(sessionId, 'x'.repeat(120))
    const title = store.list().find((session) => session.id === sessionId)?.title ?? ''

    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)

    const empty = await store.create()
    expect(store.list().find((session) => session.id === empty.id)?.title).toBe('New chat')
  })

  it('orders sessions by most recent activity', async () => {
    const { store } = await createHarness()
    const firstId = store.getActiveSessionId()!
    await store.create()
    await store.appendUserMessage(firstId, 'activity')

    expect(store.list()[0]?.id).toBe(firstId)
  })

  it('marks an interrupted streaming message on load and persists the change', async () => {
    const { store, history, historyDir } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    await history.saveSession(sessionId, [
      message({ id: 'assistant-1', content: 'partial', status: 'streaming' }),
    ])

    const reopened = await reopen(historyDir)
    const snapshot = await reopened.getActiveSnapshot()

    expect(snapshot.messages[0]?.status).toBe('interrupted')
    expect(snapshot.messages[0]?.content).toBe('partial')

    const raw = JSON.parse(await readFile(join(historyDir, `${sessionId}.json`), 'utf8')) as {
      messages: StoredMessage[]
    }
    expect(raw.messages[0]?.status).toBe('interrupted')
  })

  it('retains failed messages with their status and error', async () => {
    const { store, historyDir } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    await store.appendUserMessage(sessionId, 'fail me')
    const assistant = store.beginAssistantMessage(sessionId)
    store.appendDelta(sessionId, assistant.id, 'partial')
    await store.failRequest(sessionId, assistant.id, {
      code: 'server',
      message: 'the server failed',
    })

    const reopened = await reopen(historyDir)
    const snapshot = await reopened.getActiveSnapshot()

    const user = snapshot.messages.find((entry) => entry.role === 'user')
    const assistantMessage = snapshot.messages.find((entry) => entry.role === 'assistant')
    expect(user?.status).toBe('failed')
    expect(user?.error?.message).toBe('the server failed')
    expect(assistantMessage?.status).toBe('failed')
    expect(assistantMessage?.content).toBe('partial')
  })

  it('marks only the assistant message interrupted and keeps it after reload', async () => {
    const { store, historyDir } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    await store.appendUserMessage(sessionId, 'stop me')
    const assistant = store.beginAssistantMessage(sessionId)
    store.appendDelta(sessionId, assistant.id, 'partial answer')

    await store.interruptAssistant(sessionId, assistant.id)

    const snapshot = await store.getSnapshot(sessionId)
    expect(snapshot.messages.find((entry) => entry.role === 'user')?.status).toBe('complete')
    expect(snapshot.messages.find((entry) => entry.role === 'assistant')).toMatchObject({
      status: 'interrupted',
      content: 'partial answer',
    })

    const reopened = await reopen(historyDir)
    const restored = await reopened.getSnapshot(sessionId)
    expect(restored.messages.find((entry) => entry.role === 'user')?.status).toBe('complete')
    expect(restored.messages.find((entry) => entry.role === 'assistant')).toMatchObject({
      status: 'interrupted',
      content: 'partial answer',
    })
  })

  it('flushes without adding a message when there is no assistant message id', async () => {
    const { store, historyDir } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    await store.appendUserMessage(sessionId, 'stop me')

    await store.interruptAssistant(sessionId, null)

    const snapshot = await store.getSnapshot(sessionId)
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]).toMatchObject({
      role: 'user',
      status: 'complete',
      content: 'stop me',
    })

    const reopened = await reopen(historyDir)
    const restored = await reopened.getSnapshot(sessionId)
    expect(restored.messages).toHaveLength(1)
    expect(restored.messages[0]?.status).toBe('complete')
  })

  it('recovers from a corrupt session file without blocking startup', async () => {
    const { store, historyDir } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    await writeFile(join(historyDir, `${sessionId}.json`), '{not valid json')

    const reopened = await reopen(historyDir)

    expect((await reopened.getActiveSnapshot()).messages).toEqual([])
    expect(reopened.getWarnings().some((warning) => /invalid/i.test(warning))).toBe(true)

    const entries = await readdir(historyDir)
    expect(entries.some((entry) => entry.includes('.corrupt-'))).toBe(true)
  })

  it('recovers from a corrupt index by creating a default session', async () => {
    const { historyDir } = await createHarness()
    await writeFile(join(historyDir, 'index.json'), 'not json')

    const reopened = await reopen(historyDir)

    expect(reopened.list()).toHaveLength(1)
    expect(reopened.getActiveSessionId()).not.toBeNull()
    expect(reopened.getWarnings().length).toBeGreaterThan(0)
  })

  it('flushes streamed deltas to disk', async () => {
    const { store, historyDir } = await createHarness()
    const sessionId = store.getActiveSessionId()!
    const assistant = store.beginAssistantMessage(sessionId)
    store.appendDelta(sessionId, assistant.id, 'streamed content')

    await store.flush(sessionId)

    const raw = JSON.parse(await readFile(join(historyDir, `${sessionId}.json`), 'utf8')) as {
      messages: StoredMessage[]
    }
    expect(raw.messages[0]?.content).toBe('streamed content')
  })
})

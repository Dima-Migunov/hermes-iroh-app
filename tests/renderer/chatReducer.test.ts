import { describe, expect, it } from 'vitest'
import type { ClientConfig, SessionSnapshot, SessionSummary, StoredMessage } from '@shared/protocol'
import {
  chatReducer,
  initialChatState,
  selectActiveMessages,
  type ChatState,
} from '@renderer/state/chatReducer'

const config: ClientConfig = {
  serverTicket: 'ticket',
  serverNodeId: null,
  relayUrl: null,
}

const sessionA: SessionSummary = {
  id: 'session-a',
  title: 'Session A',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
}

const sessionB: SessionSummary = {
  id: 'session-b',
  title: 'Session B',
  createdAt: '2026-01-01T00:00:02.000Z',
  updatedAt: '2026-01-01T00:00:02.000Z',
}

function message(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'message-1',
    role: 'user',
    content: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    ...overrides,
  }
}

function bootstrapped(messages: StoredMessage[] = []): ChatState {
  const snapshot: SessionSnapshot = { session: sessionA, messages }
  return chatReducer(initialChatState, {
    type: 'bootstrap',
    identityNodeId: 'client-node',
    config,
    connection: { state: 'connected' },
    sessions: [sessionA],
    snapshot,
    notices: [],
  })
}

function sent(state: ChatState, text = 'Hi'): ChatState {
  return chatReducer(state, {
    type: 'prompt/sent',
    sessionId: 'session-a',
    text,
    messageId: 'local-user',
    createdAt: '2026-01-01T00:00:03.000Z',
  })
}

function started(state: ChatState, requestId = 'request-1'): ChatState {
  return chatReducer(state, {
    type: 'prompt/start',
    requestId,
    createdAt: '2026-01-01T00:00:04.000Z',
  })
}

describe('chatReducer transcript assembly', () => {
  it('assembles ordered deltas in place', () => {
    let state = bootstrapped()
    state = sent(state)
    state = chatReducer(state, { type: 'prompt/request', requestId: 'request-1' })
    state = started(state)
    state = chatReducer(state, {
      type: 'prompt/delta',
      requestId: 'request-1',
      chunks: ['Hel', 'lo'],
      createdAt: '2026-01-01T00:00:05.000Z',
    })
    state = chatReducer(state, {
      type: 'prompt/delta',
      requestId: 'request-1',
      chunks: ['!'],
      createdAt: '2026-01-01T00:00:06.000Z',
    })

    const messages = selectActiveMessages(state)
    expect(messages.map((entry) => entry.role)).toEqual(['user', 'assistant'])
    expect(messages[0]?.content).toBe('Hi')
    expect(messages[1]?.content).toBe('Hello!')
    expect(messages[1]?.status).toBe('streaming')
    expect(state.generating).toBe(true)

    state = chatReducer(state, { type: 'prompt/done', requestId: 'request-1' })

    expect(selectActiveMessages(state)[1]?.status).toBe('complete')
    expect(state.generating).toBe(false)
    expect(state.activeRequestId).toBeNull()
  })

  it('ignores deltas for a stale request id', () => {
    let state = bootstrapped()
    state = sent(state)
    state = started(state)
    state = chatReducer(state, {
      type: 'prompt/delta',
      requestId: 'request-1',
      chunks: ['kept'],
      createdAt: '2026-01-01T00:00:05.000Z',
    })

    const stale = chatReducer(state, {
      type: 'prompt/delta',
      requestId: 'other-request',
      chunks: ['ignored'],
      createdAt: '2026-01-01T00:00:06.000Z',
    })

    expect(selectActiveMessages(stale)[1]?.content).toBe('kept')
  })
})

describe('chatReducer session handling', () => {
  it('keeps transcripts isolated per session', () => {
    let state = bootstrapped([message({ id: 'a-1', content: 'session A message' })])

    state = chatReducer(state, {
      type: 'session/activated',
      snapshot: {
        session: sessionB,
        messages: [message({ id: 'b-1', content: 'session B message' })],
      },
    })

    expect(state.activeSessionId).toBe('session-b')
    expect(selectActiveMessages(state).map((entry) => entry.content)).toEqual([
      'session B message',
    ])

    state = chatReducer(state, {
      type: 'session/activated',
      snapshot: {
        session: sessionA,
        messages: [message({ id: 'a-1', content: 'session A message' })],
      },
    })

    expect(selectActiveMessages(state).map((entry) => entry.content)).toEqual([
      'session A message',
    ])
  })

  it('blocks switching sessions while a prompt is generating', () => {
    let state = bootstrapped()
    state = sent(state)
    state = started(state)

    state = chatReducer(state, {
      type: 'session/activated',
      snapshot: { session: sessionB, messages: [] },
    })

    expect(state.activeSessionId).toBe('session-a')

    state = chatReducer(state, { type: 'prompt/done', requestId: 'request-1' })
    state = chatReducer(state, {
      type: 'session/activated',
      snapshot: { session: sessionB, messages: [] },
    })

    expect(state.activeSessionId).toBe('session-b')
  })

  it('makes a new session active with an empty transcript', () => {
    let state = bootstrapped([message({})])
    state = chatReducer(state, { type: 'session/created', session: sessionB })

    expect(state.activeSessionId).toBe('session-b')
    expect(selectActiveMessages(state)).toEqual([])
    expect(state.sessions[0]?.id).toBe('session-b')
  })
})

describe('chatReducer terminal failures', () => {
  it('marks the user and assistant messages failed, then re-enables prompting', () => {
    let state = bootstrapped()
    state = sent(state)
    state = started(state)
    state = chatReducer(state, {
      type: 'prompt/delta',
      requestId: 'request-1',
      chunks: ['partial'],
      createdAt: '2026-01-01T00:00:05.000Z',
    })
    state = chatReducer(state, {
      type: 'prompt/error',
      requestId: 'request-1',
      sessionId: 'session-a',
      code: 'server',
      message: 'server exploded',
    })

    const [user, assistant] = selectActiveMessages(state)
    expect(user).toMatchObject({
      role: 'user',
      status: 'failed',
      error: { code: 'server', message: 'server exploded' },
    })
    expect(assistant).toMatchObject({ role: 'assistant', status: 'failed' })
    expect(state.error).toEqual({ code: 'server', message: 'server exploded' })
    expect(state.generating).toBe(false)

    state = sent(state, 'try again')
    expect(state.generating).toBe(true)
    expect(state.error).toBeNull()
  })

  it('dismisses a surfaced error', () => {
    let state = bootstrapped()
    state = { ...state, error: { code: 'timeout', message: 'timed out' } }
    state = chatReducer(state, { type: 'error/dismiss' })

    expect(state.error).toBeNull()
  })

  it('adds notices once and dismisses them by index', () => {
    let state = bootstrapped()
    const notice = { level: 'warning' as const, message: 'history could not be loaded' }

    state = chatReducer(state, { type: 'notice/add', notice })
    state = chatReducer(state, { type: 'notice/add', notice })
    expect(state.notices).toHaveLength(1)

    state = chatReducer(state, { type: 'notice/dismiss', index: 0 })
    expect(state.notices).toHaveLength(0)
  })
})

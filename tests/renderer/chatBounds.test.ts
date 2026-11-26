import { describe, expect, it } from 'vitest'
import type { ClientConfig, SessionSnapshot, SessionSummary, StoredMessage } from '@shared/protocol'
import {
  MAX_CACHED_TRANSCRIPTS,
  MAX_NOTICES,
  chatReducer,
  initialChatState,
  type ChatState,
} from '@renderer/state/chatReducer'

const config: ClientConfig = { serverTicket: null, serverNodeId: null, relayUrl: null }

function session(id: string): SessionSummary {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function snapshot(id: string, messages: StoredMessage[] = []): SessionSnapshot {
  return { session: session(id), messages }
}

function bootstrapped(): ChatState {
  return chatReducer(initialChatState, {
    type: 'bootstrap',
    identityNodeId: 'client-node',
    config,
    connection: { state: 'connected' },
    sessions: [session('session-0')],
    snapshot: snapshot('session-0'),
    notices: [],
  })
}

function activate(state: ChatState, id: string): ChatState {
  return chatReducer(state, { type: 'session/activated', snapshot: snapshot(id) })
}

describe('chatReducer transcript cache bounds', () => {
  it('keeps the active session and the most recent visits only', () => {
    let state = bootstrapped()

    for (let index = 1; index <= MAX_CACHED_TRANSCRIPTS + 2; index += 1) {
      state = activate(state, `session-${index}`)
    }

    expect(state.transcriptOrder.length).toBeLessThanOrEqual(MAX_CACHED_TRANSCRIPTS)
    expect(state.activeSessionId).toBe(`session-${MAX_CACHED_TRANSCRIPTS + 2}`)
    expect(Object.keys(state.transcripts)).toContain(`session-${MAX_CACHED_TRANSCRIPTS + 2}`)
    expect(Object.keys(state.transcripts)).not.toContain('session-0')
  })

  it('never evicts the active session', () => {
    let state = bootstrapped()
    state = activate(state, 'session-1')
    state = activate(state, 'session-0')

    expect(Object.keys(state.transcripts)).toContain('session-0')
    expect(state.activeSessionId).toBe('session-0')
  })

  it('reloads an evicted session from the snapshot later', () => {
    let state = bootstrapped()
    const message: StoredMessage = {
      id: 'm-1',
      role: 'user',
      content: 'kept on disk',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'complete',
    }
    state = chatReducer(state, {
      type: 'session/activated',
      snapshot: snapshot('session-1', [message]),
    })

    for (let index = 2; index <= MAX_CACHED_TRANSCRIPTS + 2; index += 1) {
      state = activate(state, `session-${index}`)
    }
    expect(Object.keys(state.transcripts)).not.toContain('session-1')

    state = chatReducer(state, {
      type: 'session/activated',
      snapshot: snapshot('session-1', [message]),
    })

    expect(state.transcripts['session-1']).toEqual([message])
  })
})

describe('chatReducer notice bounds', () => {
  function addNotices(state: ChatState, count: number): ChatState {
    let next = state
    for (let index = 0; index < count; index += 1) {
      next = chatReducer(next, {
        type: 'notice/add',
        notice: { level: 'warning', message: `notice ${index}` },
      })
    }
    return next
  }

  it('caps the list at 20 entries and keeps the newest', () => {
    let state = bootstrapped()
    state = addNotices(state, MAX_NOTICES + 5)

    expect(state.notices).toHaveLength(MAX_NOTICES)
    expect(state.notices[state.notices.length - 1]?.message).toBe(
      `notice ${MAX_NOTICES + 4}`,
    )
    expect(state.notices[0]?.message).toBe('notice 5')
  })

  it('gives every notice a stable unique id', () => {
    let state = bootstrapped()
    state = addNotices(state, 3)

    const ids = state.notices.map((notice) => notice.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids])
  })

  it('dismisses a notice by id and no longer by position', () => {
    let state = bootstrapped()
    state = addNotices(state, 3)

    const middle = state.notices[1]!
    state = chatReducer(state, { type: 'notice/dismiss', id: middle.id })

    expect(state.notices.map((notice) => notice.message)).toEqual([
      'notice 0',
      'notice 2',
    ])
  })
})

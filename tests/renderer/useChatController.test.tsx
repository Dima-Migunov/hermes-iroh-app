import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AppNotice,
  ClientConfig,
  ConnectionStatus,
  PromptEvent,
  SessionSnapshot,
  SessionSummary,
} from '@shared/protocol'
import { useChatController, type ChatController } from '@renderer/useChatController'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

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

const config: ClientConfig = { serverTicket: null, serverNodeId: null, relayUrl: null }

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const api = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  getConnectionStatus: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  activateSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getActiveSession: vi.fn(),
  getNotices: vi.fn(),
  sendPrompt: vi.fn(),
  cancelPrompt: vi.fn(),
  copyText: vi.fn(),
  onPromptEvent: vi.fn(),
  onConnectionStatus: vi.fn(),
  onHistoryChanged: vi.fn(),
  onNotice: vi.fn(),
}))

vi.mock('@renderer/bridge', () => ({ bridge: api }))

const promptHandlers: Array<(event: PromptEvent) => void> = []
const historyHandlers: Array<() => void> = []
const noticeHandlers: Array<(notice: AppNotice) => void> = []
const statusHandlers: Array<(status: ConnectionStatus) => void> = []

function snapshotOf(session: SessionSummary): SessionSnapshot {
  return { session, messages: [] }
}

beforeEach(() => {
  vi.resetAllMocks()
  promptHandlers.length = 0
  historyHandlers.length = 0
  noticeHandlers.length = 0
  statusHandlers.length = 0

  api.getIdentity.mockResolvedValue({ nodeId: 'client-node' })
  api.getConfig.mockResolvedValue(config)
  api.getConnectionStatus.mockResolvedValue({ state: 'connected' })
  api.listSessions.mockResolvedValue([sessionA, sessionB])
  api.getActiveSession.mockResolvedValue(snapshotOf(sessionA))
  api.getNotices.mockResolvedValue([])
  api.onPromptEvent.mockImplementation((handler: (event: PromptEvent) => void) => {
    promptHandlers.push(handler)
    return () => undefined
  })
  api.onConnectionStatus.mockImplementation((handler: (status: ConnectionStatus) => void) => {
    statusHandlers.push(handler)
    return () => undefined
  })
  api.onHistoryChanged.mockImplementation((handler: () => void) => {
    historyHandlers.push(handler)
    return () => undefined
  })
  api.onNotice.mockImplementation((handler: (notice: AppNotice) => void) => {
    noticeHandlers.push(handler)
    return () => undefined
  })
})

let root: Root | null = null
let container: HTMLDivElement | null = null
let controller: ChatController

function Probe() {
  controller = useChatController()
  return null
}

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
  await flush()
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('useChatController bootstrap', () => {
  it('still bootstraps sessions when the notices read fails', async () => {
    api.getNotices.mockRejectedValue(new Error('notices unavailable'))
    await mount()

    expect(controller.state.activeSessionId).toBe('session-a')
    expect(controller.state.sessions.map((session) => session.id)).toEqual([
      'session-a',
      'session-b',
    ])
    expect(controller.state.notices.map((notice) => notice.message)).toEqual([
      'notices unavailable',
    ])
  })

  it('keeps a notice that arrives before bootstrap resolves', async () => {
    const bootstrap = deferred<SessionSnapshot>()
    api.getActiveSession.mockReturnValue(bootstrap.promise)
    await mount()
    expect(controller.state.activeSessionId).toBeNull()

    await act(async () => {
      noticeHandlers[0]?.({ level: 'warning', message: 'live notice' })
    })
    await act(async () => {
      bootstrap.resolve(snapshotOf(sessionA))
    })
    await flush()

    expect(controller.state.notices.map((notice) => notice.message)).toEqual([
      'live notice',
    ])
    expect(controller.state.activeSessionId).toBe('session-a')
  })

  it('merges a startup notice with a live one', async () => {
    api.getNotices.mockResolvedValue([{ level: 'warning', message: 'startup notice' }])
    const bootstrap = deferred<SessionSnapshot>()
    api.getActiveSession.mockReturnValue(bootstrap.promise)
    await mount()

    await act(async () => {
      noticeHandlers[0]?.({ level: 'warning', message: 'live notice' })
    })
    await act(async () => {
      bootstrap.resolve(snapshotOf(sessionA))
    })
    await flush()

    expect(controller.state.notices.map((notice) => notice.message)).toEqual([
      'live notice',
      'startup notice',
    ])
  })
})

describe('useChatController request ownership', () => {
  it('ignores a terminal event from a different session than the request', async () => {
    await mount()
    api.sendPrompt.mockResolvedValue({ requestId: 'request-1' })

    await act(async () => {
      await controller.sendPrompt('hello')
    })

    await act(async () => {
      promptHandlers[0]?.({
        requestId: 'request-1',
        type: 'start',
        sessionId: 'session-a',
      })
    })
    await act(async () => {
      promptHandlers[0]?.({
        requestId: 'request-1',
        type: 'done',
        sessionId: 'session-b',
      })
    })

    expect(controller.state.generating).toBe(true)
  })
})

describe('useChatController session selection', () => {
  it('drops a stale activation when a newer selection resolves first', async () => {
    await mount()
    expect(controller.state.activeSessionId).toBe('session-a')

    const older = deferred<SessionSnapshot>()
    const newer = deferred<SessionSnapshot>()
    api.activateSession.mockImplementation((id: string) =>
      id === 'session-b' ? older.promise : newer.promise,
    )

    let olderCall: Promise<void> | undefined
    let newerCall: Promise<void> | undefined
    await act(async () => {
      olderCall = controller.activateSession('session-b')
      newerCall = controller.activateSession('session-c')
    })

    await act(async () => {
      newer.resolve(snapshotOf({ ...sessionB, id: 'session-c', title: 'Session C' }))
    })
    await flush()
    await newerCall
    expect(controller.state.activeSessionId).toBe('session-c')

    await act(async () => {
      older.resolve(snapshotOf(sessionB))
    })
    await flush()
    await olderCall

    expect(controller.state.activeSessionId).toBe('session-c')
  })

  it('ignores a stale history refresh', async () => {
    await mount()

    const first = deferred<SessionSummary[]>()
    const second = deferred<SessionSummary[]>()
    api.listSessions
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    await act(async () => {
      historyHandlers[0]?.()
      historyHandlers[0]?.()
    })

    await act(async () => {
      second.resolve([sessionB])
    })
    await flush()

    await act(async () => {
      first.resolve([sessionA])
    })
    await flush()

    expect(controller.state.sessions.map((session) => session.id)).toEqual(['session-b'])
  })

  it('keeps the active session when the refreshed list no longer contains it', async () => {
    await mount()
    api.listSessions.mockResolvedValue([sessionB])

    await act(async () => {
      historyHandlers[0]?.()
    })
    await flush()

    expect(controller.state.activeSessionId).toBe('session-a')
  })
})

describe('useChatController session mutations', () => {
  async function startGenerating(): Promise<void> {
    api.sendPrompt.mockResolvedValue({ requestId: 'request-1' })
    await act(async () => {
      await controller.sendPrompt('hello')
    })
    await act(async () => {
      promptHandlers[0]?.({
        requestId: 'request-1',
        type: 'start',
        sessionId: 'session-a',
      })
    })
    expect(controller.state.generating).toBe(true)
  }

  it('applies a successful rename without touching the active transcript', async () => {
    await mount()
    const renamed: SessionSummary = {
      ...sessionA,
      title: 'Renamed session',
      customTitle: true,
    }
    api.renameSession.mockResolvedValue(renamed)

    let succeeded = false
    await act(async () => {
      succeeded = await controller.renameSession('session-a', 'Renamed session')
    })

    expect(succeeded).toBe(true)
    expect(api.renameSession).toHaveBeenCalledWith('session-a', 'Renamed session')
    expect(controller.state.sessions[0]).toEqual(renamed)
    expect(controller.state.activeSessionId).toBe('session-a')
  })

  it('surfaces a rename failure and leaves the previous title in place', async () => {
    await mount()
    api.renameSession.mockRejectedValue(new Error('rename failed'))

    let succeeded = true
    await act(async () => {
      succeeded = await controller.renameSession('session-a', 'Renamed session')
    })

    expect(succeeded).toBe(false)
    expect(controller.state.sessions[0]?.title).toBe('Session A')
    expect(controller.state.notices.map((notice) => notice.message)).toEqual([
      'rename failed',
    ])
  })

  it('keeps a custom title when the first prompt is sent afterwards', async () => {
    await mount()
    const renamed: SessionSummary = {
      ...sessionA,
      title: 'Renamed session',
      customTitle: true,
    }
    api.renameSession.mockResolvedValue(renamed)
    api.sendPrompt.mockResolvedValue({ requestId: 'request-1' })

    await act(async () => {
      await controller.renameSession('session-a', 'Renamed session')
    })
    await act(async () => {
      await controller.sendPrompt('this must not replace the title')
    })
    await act(async () => {
      promptHandlers[0]?.({
        requestId: 'request-1',
        type: 'start',
        sessionId: 'session-a',
      })
      promptHandlers[0]?.({
        requestId: 'request-1',
        type: 'done',
        sessionId: 'session-a',
      })
    })

    expect(controller.state.sessions[0]?.title).toBe('Renamed session')
    expect(controller.state.sessions[0]?.customTitle).toBe(true)
  })

  it('does not rename while a response is generating', async () => {
    await mount()
    await startGenerating()

    let succeeded = true
    await act(async () => {
      succeeded = await controller.renameSession('session-a', 'Renamed session')
    })

    expect(succeeded).toBe(false)
    expect(api.renameSession).not.toHaveBeenCalled()
  })

  it('applies a deletion result and discards a pending activation', async () => {
    await mount()
    const pending = deferred<SessionSnapshot>()
    api.activateSession.mockReturnValue(pending.promise)

    let activation: Promise<void> | undefined
    await act(async () => {
      activation = controller.activateSession('session-b')
    })

    api.deleteSession.mockResolvedValue({
      sessions: [sessionB],
      activeSession: snapshotOf(sessionB),
    })

    let deleted = false
    await act(async () => {
      deleted = (await controller.deleteSession('session-a')) !== null
    })

    expect(deleted).toBe(true)
    expect(controller.state.sessions.map((session) => session.id)).toEqual(['session-b'])
    expect(controller.state.activeSessionId).toBe('session-b')

    await act(async () => {
      pending.resolve(snapshotOf(sessionB))
    })
    await flush()
    await activation

    expect(controller.state.activeSessionId).toBe('session-b')
    expect(controller.state.sessions.map((session) => session.id)).toEqual(['session-b'])
  })

  it('keeps the session list when a deletion fails', async () => {
    await mount()
    api.deleteSession.mockRejectedValue(new Error('delete failed'))

    let deleted = true
    await act(async () => {
      deleted = (await controller.deleteSession('session-a')) !== null
    })

    expect(deleted).toBe(false)
    expect(controller.state.sessions.map((session) => session.id)).toEqual([
      'session-a',
      'session-b',
    ])
    expect(controller.state.activeSessionId).toBe('session-a')
    expect(controller.state.notices.map((notice) => notice.message)).toEqual([
      'delete failed',
    ])
  })

  it('does not delete while a response is generating', async () => {
    await mount()
    await startGenerating()

    let result = 'not-null'
    await act(async () => {
      result = (await controller.deleteSession('session-a')) === null ? 'null' : 'not-null'
    })

    expect(result).toBe('null')
    expect(api.deleteSession).not.toHaveBeenCalled()
  })
})

describe('useChatController send failures', () => {
  it('preserves the backend error code and ends generation', async () => {
    await mount()
    const error = Object.assign(new Error('A response is already in progress.'), {
      code: 'busy',
    })
    api.sendPrompt.mockRejectedValue(error)

    let result = false
    await act(async () => {
      result = await controller.sendPrompt('hello')
    })

    expect(result).toBe(true)
    expect(controller.state.error).toEqual({
      code: 'busy',
      message: 'A response is already in progress.',
    })
    expect(controller.state.generating).toBe(false)
  })

  it('keeps the failure with the request that failed', async () => {
    await mount()
    api.sendPrompt.mockRejectedValue(new Error('network down'))

    await act(async () => {
      await controller.sendPrompt('hello')
    })

    expect(controller.state.error?.message).toBe('network down')
    expect(controller.state.transcripts['session-a']?.map((entry) => entry.status)).toEqual([
      'failed',
    ])
  })

  it('blocks a second submission while the first is in flight', async () => {
    await mount()
    const pending = deferred<{ requestId: string }>()
    api.sendPrompt.mockReturnValue(pending.promise)

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = controller.sendPrompt('first')
      second = controller.sendPrompt('second')
    })

    await act(async () => {
      pending.resolve({ requestId: 'request-1' })
    })
    await flush()
    await act(async () => {
      await first
    })

    await expect(second).resolves.toBe(false)
    expect(api.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('refuses to send without an active session or with blank text', async () => {
    await mount()

    await expect(controller.sendPrompt('   ')).resolves.toBe(false)
    expect(api.sendPrompt).not.toHaveBeenCalled()
  })
})

describe('useChatController delta batching', () => {
  it('keeps arrival order and the final content', async () => {
    await mount()
    api.sendPrompt.mockResolvedValue({ requestId: 'request-1' })

    await act(async () => {
      await controller.sendPrompt('hello')
    })
    await act(async () => {
      promptHandlers[0]?.({
        requestId: 'request-1',
        type: 'start',
        sessionId: 'session-a',
      })
    })

    vi.useFakeTimers()
    try {
      await act(async () => {
        for (const content of ['a', 'b', 'c']) {
          promptHandlers[0]?.({ requestId: 'request-1', type: 'delta', content })
        }
      })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
    } finally {
      vi.useRealTimers()
    }

    const assistant = controller.state.transcripts['session-a']?.[1]
    expect(assistant?.content).toBe('abc')
    expect(assistant?.status).toBe('streaming')
  })

  it('flushes buffered text before a tool event and batches the following text', async () => {
    await mount()
    api.sendPrompt.mockResolvedValue({ requestId: 'request-1' })

    await act(async () => {
      await controller.sendPrompt('hello')
    })
    await act(async () => {
      promptHandlers[0]?.({
        requestId: 'request-1',
        type: 'start',
        sessionId: 'session-a',
      })
    })

    vi.useFakeTimers()
    try {
      await act(async () => {
        promptHandlers[0]?.({ requestId: 'request-1', type: 'delta', content: 'before\n' })
      })
      await act(async () => {
        promptHandlers[0]?.({
          requestId: 'request-1',
          type: 'tool',
          sessionId: 'session-a',
          id: 'call-1',
          name: 'search',
          arguments: { query: 'docs' },
          truncated: false,
          lineIndex: 1,
        })
      })

      const afterTool = controller.state.transcripts['session-a']?.[1]
      expect(afterTool?.content).toBe('before\n')
      expect(afterTool?.toolCalls).toEqual([
        {
          id: 'call-1',
          name: 'search',
          arguments: { query: 'docs' },
          truncated: false,
          lineIndex: 1,
        },
      ])

      await act(async () => {
        promptHandlers[0]?.({ requestId: 'request-1', type: 'delta', content: 'after\n' })
      })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
    } finally {
      vi.useRealTimers()
    }

    const assistant = controller.state.transcripts['session-a']?.[1]
    expect(assistant?.content).toBe('before\nafter\n')
    expect(assistant?.toolCalls).toHaveLength(1)
    expect(assistant?.status).toBe('streaming')
  })
})

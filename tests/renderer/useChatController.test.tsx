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
})

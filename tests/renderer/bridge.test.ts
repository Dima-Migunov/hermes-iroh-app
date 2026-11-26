import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { bridge } from '@renderer/bridge'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

const DOCUMENTED_MEMBERS = [
  'activateSession',
  'cancelPrompt',
  'connect',
  'copyText',
  'createSession',
  'deleteSession',
  'disconnect',
  'getActiveSession',
  'getConfig',
  'getConnectionStatus',
  'getIdentity',
  'getNotices',
  'getSession',
  'listSessions',
  'onConnectionStatus',
  'onHistoryChanged',
  'onNotice',
  'onPromptEvent',
  'renameSession',
  'saveConfig',
  'sendPrompt',
]

describe('renderer bridge', () => {
  it('exposes exactly the documented frozen members', () => {
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual(DOCUMENTED_MEMBERS)
    expect((bridge as unknown as Record<string, unknown>).invoke).toBeUndefined()
  })

  it('dispatches documented calls on their commands', async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true })

    await bridge.getIdentity()
    await bridge.getConnectionStatus()
    await bridge.listSessions()

    expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual([
      'identity_get',
      'connection_status',
      'sessions_list',
    ])
  })

  it('dispatches session renames with trimmed titles and deletions by id', async () => {
    vi.mocked(invoke).mockResolvedValue({})

    await bridge.renameSession('session-1', '  Renamed session  ')
    await bridge.deleteSession('session-1')

    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'sessions_rename', {
      sessionId: 'session-1',
      title: 'Renamed session',
    })
    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'sessions_delete', {
      sessionId: 'session-1',
    })
  })

  it('rejects empty rename fields before dispatch', async () => {
    vi.mocked(invoke).mockClear()

    await expect(bridge.renameSession('', 'Title')).rejects.toBeInstanceOf(TypeError)
    await expect(bridge.renameSession('session-1', '   ')).rejects.toBeInstanceOf(TypeError)
    await expect(bridge.deleteSession('')).rejects.toBeInstanceOf(TypeError)
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('dispatches prompt cancellation with no arguments', async () => {
    vi.mocked(invoke).mockResolvedValue(true)

    await expect(bridge.cancelPrompt()).resolves.toBe(true)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('prompt_cancel', undefined)
  })

  it('rejects malformed configuration before dispatch', async () => {
    vi.mocked(invoke).mockClear()

    await expect(
      bridge.saveConfig({ serverTicket: 3 } as unknown as Parameters<typeof bridge.saveConfig>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      bridge.saveConfig({} as unknown as Parameters<typeof bridge.saveConfig>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('dispatches a valid configuration as the payload argument', async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true })
    const config = { serverTicket: 'ticket-value', serverNodeId: null, relayUrl: null }

    await bridge.saveConfig(config)

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('config_save', { payload: config })
  })

  it('converts a structured command error into an Error with a code', async () => {
    vi.mocked(invoke).mockRejectedValue({
      code: 'configuration',
      message: 'A server target is required.',
    })

    const caught = await bridge.connect().catch((error: unknown) => error)
    const error = caught as Error & { code?: string }

    expect(error.message).toBe('A server target is required.')
    expect(error.code).toBe('configuration')
  })

  it('passes through string command errors', async () => {
    vi.mocked(invoke).mockRejectedValue('The server is offline.')

    await expect(bridge.connect()).rejects.toThrow('The server is offline.')
  })

  it('rejects malformed prompt submissions before dispatch', async () => {
    vi.mocked(invoke).mockClear()

    await expect(
      bridge.sendPrompt({ sessionId: 's1' } as unknown as Parameters<typeof bridge.sendPrompt>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      bridge.sendPrompt({ sessionId: 's1', text: 5 } as unknown as Parameters<
        typeof bridge.sendPrompt
      >[0]),
    ).rejects.toBeInstanceOf(TypeError)
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('rejects invalid session ids and clipboard values before dispatch', async () => {
    vi.mocked(invoke).mockClear()

    await expect(bridge.activateSession('')).rejects.toBeInstanceOf(TypeError)
    await expect(bridge.copyText(null as unknown as string)).rejects.toBeInstanceOf(TypeError)
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('subscribes to every event channel with a synchronous unsubscribe', async () => {
    const stops = new Map<string, ReturnType<typeof vi.fn>>()
    const handlers = new Map<string, (event: { payload: unknown }) => void>()

    vi.mocked(listen).mockImplementation(async (event: string, handler: any) => {
      const stop = vi.fn()
      stops.set(event, stop)
      handlers.set(event, handler)
      return stop
    })

    const promptHandler = vi.fn()
    const statusHandler = vi.fn()
    const historyHandler = vi.fn()
    const noticeHandler = vi.fn()

    const unsubscribePrompt = bridge.onPromptEvent(promptHandler)
    const unsubscribeStatus = bridge.onConnectionStatus(statusHandler)
    const unsubscribeHistory = bridge.onHistoryChanged(historyHandler)
    const unsubscribeNotice = bridge.onNotice(noticeHandler)

    await Promise.resolve()

    expect([...handlers.keys()].sort()).toEqual(
      ['app:notice', 'connection:status-changed', 'history:changed', 'prompt:event'].sort(),
    )

    handlers.get('prompt:event')?.({ payload: { type: 'done', requestId: 'r1', sessionId: 's1' } })
    expect(promptHandler).toHaveBeenCalledWith({
      type: 'done',
      requestId: 'r1',
      sessionId: 's1',
    })

    unsubscribePrompt()
    expect(stops.get('prompt:event')).toHaveBeenCalledTimes(1)

    unsubscribeStatus()
    unsubscribeHistory()
    unsubscribeNotice()
    expect(stops.get('connection:status-changed')).toHaveBeenCalledTimes(1)
    expect(stops.get('history:changed')).toHaveBeenCalledTimes(1)
    expect(stops.get('app:notice')).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes even when listen resolves after the caller disposed it', async () => {
    const deferred: { resolve?: (stop: () => void) => void } = {}
    const stop = vi.fn()

    vi.mocked(listen).mockReturnValue(
      new Promise<() => void>((resolve) => {
        deferred.resolve = resolve
      }),
    )

    const unsubscribe = bridge.onPromptEvent(() => undefined)
    unsubscribe()

    deferred.resolve?.(stop)
    await Promise.resolve()
    await Promise.resolve()

    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-function subscription handler', () => {
    expect(() => bridge.onPromptEvent(null as unknown as () => void)).toThrowError(TypeError)
  })
})

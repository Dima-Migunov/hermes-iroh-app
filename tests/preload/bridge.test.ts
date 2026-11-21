import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { createBridge } from '@preload/bridge'

interface Listener {
  (event: unknown, payload: unknown): void
}

function createHarness() {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const listeners = new Map<string, Set<Listener>>()

  const invoker = {
    invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
      calls.push({ channel, args })
      return { ok: true }
    },
  }

  const events = {
    on: (channel: string, listener: Listener): void => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(channel, set)
    },
    removeListener: (channel: string, listener: Listener): void => {
      listeners.get(channel)?.delete(listener)
    },
  }

  return { bridge: createBridge(invoker, events), calls, listeners }
}

const DOCUMENTED_MEMBERS = [
  'activateSession',
  'cancelPrompt',
  'connect',
  'copyText',
  'createSession',
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
  'saveConfig',
  'sendPrompt',
]

describe('preload bridge', () => {
  it('exposes exactly the documented frozen members', () => {
    const { bridge } = createHarness()

    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual(DOCUMENTED_MEMBERS)
    expect((bridge as unknown as Record<string, unknown>).invoke).toBeUndefined()
  })

  it('dispatches documented calls on their channels', async () => {
    const { bridge, calls } = createHarness()

    await bridge.getIdentity()
    await bridge.getConnectionStatus()
    await bridge.listSessions()

    expect(calls.map((call) => call.channel)).toEqual([
      IPC.identityGet,
      IPC.connectionStatus,
      IPC.sessionsList,
    ])
  })

  it('dispatches prompt cancellation on its channel', async () => {
    const { bridge, calls } = createHarness()

    await expect(bridge.cancelPrompt()).resolves.toEqual({ ok: true })
    expect(calls).toEqual([{ channel: IPC.promptCancel, args: [] }])
  })

  it('rejects malformed configuration before dispatch', async () => {
    const { bridge, calls } = createHarness()

    await expect(
      bridge.saveConfig({ serverTicket: 3 } as unknown as Parameters<typeof bridge.saveConfig>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      bridge.saveConfig({} as unknown as Parameters<typeof bridge.saveConfig>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('dispatches a valid configuration unchanged', async () => {
    const { bridge, calls } = createHarness()
    const config = { serverTicket: 'ticket-value', serverNodeId: null, relayUrl: null }

    await bridge.saveConfig(config)

    expect(calls).toEqual([{ channel: IPC.configSave, args: [config] }])
  })

  it('surfaces main-process errors without the Electron IPC wrapper', async () => {
    const bridge = createBridge(
      {
        invoke: async (): Promise<unknown> => {
          throw new Error(
            "Error invoking remote method 'config:save': AppError: A server target is required: paste an endpoint ticket or a server NodeId.",
          )
        },
      },
      { on: () => undefined, removeListener: () => undefined },
    )

    const error = (await bridge
      .saveConfig({ serverTicket: null, serverNodeId: null, relayUrl: null })
      .catch((caught: unknown) => caught)) as Error

    expect(error.message).toBe(
      'A server target is required: paste an endpoint ticket or a server NodeId.',
    )
  })

  it('passes through errors that carry no Electron wrapper', async () => {
    const bridge = createBridge(
      {
        invoke: async (): Promise<unknown> => {
          throw new Error('The server is offline.')
        },
      },
      { on: () => undefined, removeListener: () => undefined },
    )

    await expect(bridge.connect()).rejects.toThrow('The server is offline.')
  })

  it('rejects malformed prompt submissions before dispatch', async () => {
    const { bridge, calls } = createHarness()

    await expect(
      bridge.sendPrompt({ sessionId: 's1' } as unknown as Parameters<typeof bridge.sendPrompt>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      bridge.sendPrompt({ sessionId: 's1', text: 5 } as unknown as Parameters<
        typeof bridge.sendPrompt
      >[0]),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      bridge.sendPrompt(null as unknown as Parameters<typeof bridge.sendPrompt>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('rejects invalid session ids and clipboard values before dispatch', async () => {
    const { bridge, calls } = createHarness()

    await expect(bridge.activateSession('')).rejects.toBeInstanceOf(TypeError)
    await expect(
      bridge.activateSession(42 as unknown as Parameters<typeof bridge.activateSession>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      bridge.copyText(null as unknown as Parameters<typeof bridge.copyText>[0]),
    ).rejects.toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('subscribes to every event channel and unsubscribes cleanly', () => {
    const { bridge, listeners } = createHarness()

    const promptHandler = vi.fn()
    const statusHandler = vi.fn()
    const historyHandler = vi.fn()
    const noticeHandler = vi.fn()

    const unsubscribePrompt = bridge.onPromptEvent(promptHandler)
    bridge.onConnectionStatus(statusHandler)
    bridge.onHistoryChanged(historyHandler)
    bridge.onNotice(noticeHandler)

    expect([...listeners.keys()].sort()).toEqual(
      [IPC.connectionStatusChanged, IPC.historyChanged, IPC.notice, IPC.promptEvent].sort(),
    )

    const promptListeners = listeners.get(IPC.promptEvent)
    expect(promptListeners?.size).toBe(1)
    const [listener] = [...(promptListeners ?? [])]
    listener(undefined, { type: 'done', requestId: 'r1', sessionId: 's1' })
    expect(promptHandler).toHaveBeenCalledWith({
      type: 'done',
      requestId: 'r1',
      sessionId: 's1',
    })

    unsubscribePrompt()
    expect(promptListeners?.size).toBe(0)
  })

  it('rejects a non-function subscription handler', () => {
    const { bridge } = createHarness()

    expect(() =>
      bridge.onPromptEvent(null as unknown as () => void),
    ).toThrowError(TypeError)
  })
})

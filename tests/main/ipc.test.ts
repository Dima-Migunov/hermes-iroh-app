import { describe, expect, it, vi } from 'vitest'
import type { ClientConfig, SessionSnapshot, SessionSummary } from '@shared/protocol'
import { IPC } from '@shared/ipc'
import {
  HANDLED_CHANNELS,
  registerIpcHandlers,
  type IpcDeps,
  type IpcInvokeEventLike,
  type IpcMainLike,
} from '@main/ipc'
import type { ConfigStore } from '@main/storage/config'
import type { SessionStore } from '@main/sessions/sessionStore'

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<
    string,
    (event: IpcInvokeEventLike, ...args: unknown[]) => unknown
  >()

  handle(
    channel: string,
    listener: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown,
  ): void {
    this.handlers.set(channel, listener)
  }

  async invoke(
    channel: string,
    payload?: unknown,
    event: IpcInvokeEventLike = trustedEvent,
  ): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for ${channel}`)
    return handler(event, payload)
  }
}

const trustedEvent: IpcInvokeEventLike = {
  senderFrame: { url: 'file:///app/out/renderer/index.html' },
}

const summary: SessionSummary = {
  id: 'session-1',
  title: 'Chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const snapshot: SessionSnapshot = { session: summary, messages: [] }

const alternateConfig: ClientConfig = {
  serverTicket: 'old-ticket',
  serverNodeId: null,
  relayUrl: null,
}

function createHarness(overrides: Partial<IpcDeps> = {}) {
  const ipc = new FakeIpcMain()
  let config = { ...alternateConfig }

  const save = vi.fn(async (input: ClientConfig) => {
    config = { ...input }
    return { ...config }
  })
  const disconnect = vi.fn(async () => undefined)
  const connect = vi.fn(async () => ({ state: 'connected' as const }))
  const sendPrompt = vi.fn(async () => ({ requestId: 'request-1' }))
  const copyText = vi.fn()
  const list = vi.fn(() => [summary])
  const create = vi.fn(async () => summary)
  const activate = vi.fn(async () => snapshot)
  const getSnapshot = vi.fn(async () => snapshot)
  const getActiveSnapshot = vi.fn(async () => snapshot)

  const deps: IpcDeps = {
    identity: { nodeId: 'client-node-id' },
    configStore: {
      getCached: () => ({ ...config }),
      save,
    } as unknown as ConfigStore,
    connection: {
      getStatus: () => ({ state: 'disconnected' }),
      connect,
      disconnect,
    },
    sessions: {
      list,
      create,
      activate,
      getSnapshot,
      getActiveSnapshot,
    } as unknown as SessionStore,
    prompts: { sendPrompt },
    copyText,
    notices: ['history warning'],
    allowedUrlPrefixes: ['file:///app/out/renderer/'],
    ...overrides,
  }

  registerIpcHandlers(ipc, deps)

  return {
    ipc,
    save,
    disconnect,
    connect,
    sendPrompt,
    copyText,
    list,
    create,
    activate,
    getSnapshot,
    getActiveSnapshot,
  }
}

describe('registerIpcHandlers', () => {
  it('registers exactly the documented channel allowlist', () => {
    const { ipc } = createHarness()
    expect([...ipc.handlers.keys()].sort()).toEqual([...HANDLED_CHANNELS].sort())
  })

  it('has no handler for an unknown channel', async () => {
    const { ipc } = createHarness()
    await expect(ipc.invoke('privileged:unknown')).rejects.toThrow(/No handler/)
  })

  it('rejects requests from an untrusted sender without touching services', async () => {
    const { ipc, save } = createHarness()

    await expect(
      ipc.invoke(
        IPC.configSave,
        alternateConfig,
        { senderFrame: { url: 'https://evil.example/app' } },
      ),
    ).rejects.toMatchObject({ code: 'configuration' })
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects a malformed configuration payload before saving', async () => {
    const { ipc, save } = createHarness()

    await expect(
      ipc.invoke(IPC.configSave, { serverTicket: 42, serverNodeId: null, relayUrl: null }),
    ).rejects.toMatchObject({ code: 'configuration' })
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects a prompt missing text before opening a stream', async () => {
    const { ipc, sendPrompt } = createHarness()

    await expect(ipc.invoke(IPC.promptSend, { sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'configuration',
    })
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('rejects a non-string session id before activating a session', async () => {
    const { ipc, activate } = createHarness()

    await expect(ipc.invoke(IPC.sessionsActivate, 42)).rejects.toMatchObject({
      code: 'configuration',
    })
    expect(activate).not.toHaveBeenCalled()
  })

  it('rejects non-string clipboard writes', async () => {
    const { ipc, copyText } = createHarness()

    await expect(ipc.invoke(IPC.clipboardWrite, { text: 'no' })).rejects.toMatchObject({
      code: 'configuration',
    })
    expect(copyText).not.toHaveBeenCalled()
  })

  it('returns identity and notices', async () => {
    const { ipc } = createHarness()

    await expect(ipc.invoke(IPC.identityGet)).resolves.toEqual({ nodeId: 'client-node-id' })
    await expect(ipc.invoke(IPC.noticesGet)).resolves.toEqual([
      { level: 'warning', message: 'history warning' },
    ])
  })

  it('delegates a valid prompt request', async () => {
    const { ipc, sendPrompt } = createHarness()

    await expect(
      ipc.invoke(IPC.promptSend, { sessionId: 'session-1', text: 'hello' }),
    ).resolves.toEqual({ requestId: 'request-1' })
    expect(sendPrompt).toHaveBeenCalledWith({ sessionId: 'session-1', text: 'hello' })
  })

  it('saves a configuration and disconnects when the target changes', async () => {
    const { ipc, save, disconnect } = createHarness()

    await ipc.invoke(IPC.configSave, {
      serverTicket: 'new-ticket',
      serverNodeId: null,
      relayUrl: null,
    })

    expect(save).toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('does not disconnect when saving identical settings', async () => {
    const { ipc, save, disconnect } = createHarness()

    await ipc.invoke(IPC.configSave, { ...alternateConfig })

    expect(save).toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('delegates connection and history operations', async () => {
    const { ipc, connect, list, create, getActiveSnapshot } = createHarness()

    await expect(ipc.invoke(IPC.connectionConnect)).resolves.toEqual({ state: 'connected' })
    await expect(ipc.invoke(IPC.connectionStatus)).resolves.toEqual({ state: 'disconnected' })
    await ipc.invoke(IPC.connectionDisconnect)
    await expect(ipc.invoke(IPC.sessionsList)).resolves.toEqual([summary])
    await expect(ipc.invoke(IPC.sessionsCreate)).resolves.toEqual(summary)
    await expect(ipc.invoke(IPC.sessionsGetActive)).resolves.toEqual(snapshot)

    expect(connect).toHaveBeenCalled()
    expect(list).toHaveBeenCalled()
    expect(create).toHaveBeenCalled()
    expect(getActiveSnapshot).toHaveBeenCalled()
  })

  it('writes copied text through the injected clipboard', async () => {
    const { ipc, copyText } = createHarness()

    await ipc.invoke(IPC.clipboardWrite, 'copy me')

    expect(copyText).toHaveBeenCalledWith('copy me')
  })
})

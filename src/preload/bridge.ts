import type { IpcApi, PromptSubmission } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type {
  AppNotice,
  ClientConfig,
  ConnectionStatus,
  PromptEvent,
  SessionSnapshot,
  SessionSummary,
} from '@shared/protocol'

export interface InvokeTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export interface SubscriptionTransport {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string.`)
  }
  return value
}

function requireNonEmptyString(value: unknown, name: string): string {
  const text = requireString(value, name)
  if (text.length === 0) throw new TypeError(`${name} must not be empty.`)
  return text
}

function requireNullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string or null.`)
  }
  return value
}

function requirePresentNullableString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (!(key in record)) {
    throw new TypeError(`${label} is required and must be a string or null.`)
  }
  return requireNullableString(record[key], label)
}

function requireConfig(value: unknown): ClientConfig {
  if (!isRecord(value)) throw new TypeError('config must be an object.')
  return {
    serverTicket: requirePresentNullableString(value, 'serverTicket', 'config.serverTicket'),
    serverNodeId: requirePresentNullableString(value, 'serverNodeId', 'config.serverNodeId'),
    relayUrl: requirePresentNullableString(value, 'relayUrl', 'config.relayUrl'),
  }
}

function requirePromptSubmission(value: unknown): PromptSubmission {
  if (!isRecord(value)) throw new TypeError('prompt must be an object.')
  return {
    sessionId: requireNonEmptyString(value.sessionId, 'prompt.sessionId'),
    text: requireString(value.text, 'prompt.text'),
  }
}

const ELECTRON_IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/
const APP_ERROR_NAME = /^AppError:\s*/

export function cleanIpcErrorMessage(message: string): string {
  return message.replace(ELECTRON_IPC_WRAPPER, '').replace(APP_ERROR_NAME, '')
}

export function createBridge(
  invoker: InvokeTransport,
  events: SubscriptionTransport,
): IpcApi {
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    try {
      return await invoker.invoke(channel, ...args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(cleanIpcErrorMessage(message))
    }
  }

  const subscribe = <T>(
    channel: string,
    handler: (payload: T) => void,
  ): (() => void) => {
    if (typeof handler !== 'function') {
      throw new TypeError('The event handler must be a function.')
    }

    const listener = (_event: unknown, payload: unknown): void => {
      handler(payload as T)
    }
    events.on(channel, listener)
    return () => {
      events.removeListener(channel, listener)
    }
  }

  const api: IpcApi = {
    getIdentity: async () =>
      (await invoke(IPC.identityGet)) as { nodeId: string },

    getConfig: async () => (await invoke(IPC.configGet)) as ClientConfig,

    saveConfig: async (config: ClientConfig) =>
      (await invoke(IPC.configSave, requireConfig(config))) as ClientConfig,

    getConnectionStatus: async () =>
      (await invoke(IPC.connectionStatus)) as ConnectionStatus,

    connect: async () => (await invoke(IPC.connectionConnect)) as ConnectionStatus,

    disconnect: async () => {
      await invoke(IPC.connectionDisconnect)
    },

    listSessions: async () =>
      (await invoke(IPC.sessionsList)) as SessionSummary[],

    createSession: async () =>
      (await invoke(IPC.sessionsCreate)) as SessionSummary,

    activateSession: async (id: string) =>
      (await invoke(
        IPC.sessionsActivate,
        requireNonEmptyString(id, 'session id'),
      )) as SessionSnapshot,

    getSession: async (id: string) =>
      (await invoke(
        IPC.sessionsGet,
        requireNonEmptyString(id, 'session id'),
      )) as SessionSnapshot,

    getActiveSession: async () =>
      (await invoke(IPC.sessionsGetActive)) as SessionSnapshot,

    getNotices: async () => (await invoke(IPC.noticesGet)) as AppNotice[],

    sendPrompt: async (input: PromptSubmission) =>
      (await invoke(
        IPC.promptSend,
        requirePromptSubmission(input),
      )) as { requestId: string },

    copyText: async (text: string) => {
      await invoke(IPC.clipboardWrite, requireString(text, 'text'))
    },

    onPromptEvent: (handler: (event: PromptEvent) => void) =>
      subscribe(IPC.promptEvent, handler),

    onConnectionStatus: (handler: (status: ConnectionStatus) => void) =>
      subscribe(IPC.connectionStatusChanged, handler),

    onHistoryChanged: (handler: () => void) => subscribe(IPC.historyChanged, handler),

    onNotice: (handler: (notice: AppNotice) => void) => subscribe(IPC.notice, handler),
  }

  return Object.freeze(api)
}

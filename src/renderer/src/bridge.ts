import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IpcApi, PromptSubmission } from '@shared/ipc'
import type {
  AppNotice,
  ClientConfig,
  ConnectionStatus,
  PromptEvent,
  SessionSnapshot,
  SessionSummary,
} from '@shared/protocol'

const EVENTS = {
  promptEvent: 'prompt:event',
  connectionStatusChanged: 'connection:status-changed',
  historyChanged: 'history:changed',
  notice: 'app:notice',
} as const

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

function toError(error: unknown): Error {
  if (error instanceof Error) return new Error(error.message)
  if (typeof error === 'string') return new Error(error)
  if (isRecord(error) && typeof error.message === 'string') {
    const converted = new Error(error.message)
    if (typeof error.code === 'string') {
      Object.assign(converted, { code: error.code })
    }
    return converted
  }
  return new Error('An unexpected error occurred.')
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toError(error)
  }
}

function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  if (typeof handler !== 'function') {
    throw new TypeError('The event handler must be a function.')
  }

  let unlisten: UnlistenFn | null = null
  let disposed = false

  void listen<T>(event, (incoming) => {
    handler(incoming.payload)
  })
    .then((stop) => {
      if (disposed) {
        stop()
        return
      }
      unlisten = stop
    })
    .catch(() => undefined)

  return () => {
    disposed = true
    if (unlisten) {
      unlisten()
      unlisten = null
    }
  }
}

const api: IpcApi = {
  getIdentity: async () => call('identity_get'),

  getConfig: async () => call('config_get'),

  saveConfig: async (config: ClientConfig) =>
    call('config_save', { payload: requireConfig(config) }),

  getConnectionStatus: async () => call<ConnectionStatus>('connection_status'),

  connect: async () => call<ConnectionStatus>('connection_connect'),

  disconnect: async () => {
    await call('connection_disconnect')
  },

  listSessions: async () => call<SessionSummary[]>('sessions_list'),

  createSession: async () => call<SessionSummary>('sessions_create'),

  activateSession: async (id: string) =>
    call<SessionSnapshot>('sessions_activate', {
      sessionId: requireNonEmptyString(id, 'session id'),
    }),

  getSession: async (id: string) =>
    call<SessionSnapshot>('sessions_get', {
      sessionId: requireNonEmptyString(id, 'session id'),
    }),

  getActiveSession: async () => call<SessionSnapshot>('sessions_get_active'),

  getNotices: async () => call<AppNotice[]>('notices_get'),

  sendPrompt: async (input: PromptSubmission) =>
    call<{ requestId: string }>('prompt_send', {
      payload: requirePromptSubmission(input),
    }),

  cancelPrompt: async () => call<boolean>('prompt_cancel'),

  copyText: async (text: string) => {
    await call('clipboard_write', { text: requireString(text, 'text') })
  },

  onPromptEvent: (handler: (event: PromptEvent) => void) =>
    subscribe(EVENTS.promptEvent, handler),

  onConnectionStatus: (handler: (status: ConnectionStatus) => void) =>
    subscribe(EVENTS.connectionStatusChanged, handler),

  onHistoryChanged: (handler: () => void) =>
    subscribe(EVENTS.historyChanged, handler),

  onNotice: (handler: (notice: AppNotice) => void) => subscribe(EVENTS.notice, handler),
}

export const bridge: IpcApi = Object.freeze(api)

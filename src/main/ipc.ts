import { z } from 'zod'
import type { PromptSubmission, PromptSubmissionResult } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type { ClientConfig, ConnectionStatus } from '@shared/protocol'
import { AppError } from './errors'
import type { ConfigStore } from './storage/config'
import type { SessionStore } from './sessions/sessionStore'

export interface IpcInvokeEventLike {
  senderFrame?: {
    url?: string
  } | null
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown,
  ): void
}

export interface ConnectionService {
  getStatus(): ConnectionStatus
  connect(): Promise<ConnectionStatus>
  disconnect(): Promise<void>
}

export interface PromptService {
  sendPrompt(input: PromptSubmission): Promise<PromptSubmissionResult>
  cancelPrompt(): Promise<boolean>
}

export interface IpcDeps {
  identity: { nodeId: string }
  configStore: ConfigStore
  connection: ConnectionService
  sessions: SessionStore
  prompts: PromptService
  copyText(text: string): void
  notices: string[]
  allowedUrlPrefixes: string[]
}

const configSchema = z
  .object({
    serverTicket: z.string().max(4096).nullable(),
    serverNodeId: z.string().max(4096).nullable(),
    relayUrl: z.string().max(4096).nullable(),
  })
  .strict()

const sessionIdSchema = z.string().min(1).max(128)

const promptSchema = z
  .object({
    sessionId: sessionIdSchema,
    text: z.string().min(1).max(200_000),
  })
  .strict()

const copyTextSchema = z.string().max(2_000_000)

export const HANDLED_CHANNELS = [
  IPC.identityGet,
  IPC.configGet,
  IPC.configSave,
  IPC.connectionStatus,
  IPC.connectionConnect,
  IPC.connectionDisconnect,
  IPC.sessionsList,
  IPC.sessionsCreate,
  IPC.sessionsActivate,
  IPC.sessionsGet,
  IPC.sessionsGetActive,
  IPC.promptSend,
  IPC.promptCancel,
  IPC.clipboardWrite,
  IPC.noticesGet,
] as const

export function registerIpcHandlers(ipc: IpcMainLike, deps: IpcDeps): void {
  const isTrustedSender = (event: IpcInvokeEventLike): boolean => {
    const url = event.senderFrame?.url
    if (typeof url !== 'string' || url.length === 0) return false
    return deps.allowedUrlPrefixes.some((prefix) => prefix.length > 0 && url.startsWith(prefix))
  }

  const handle = <T>(
    channel: string,
    schema: z.ZodType<T> | null,
    handler: (input: T) => unknown,
  ): void => {
    ipc.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) {
        throw new AppError('configuration', 'The IPC request did not come from the application window.')
      }

      let input = payload as T
      if (schema) {
        const parsed = schema.safeParse(payload)
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
            .join('; ')
          throw new AppError('configuration', `Invalid request on ${channel}: ${detail}`)
        }
        input = parsed.data
      }

      return handler(input)
    })
  }

  handle(IPC.identityGet, null, () => ({ nodeId: deps.identity.nodeId }))
  handle(IPC.configGet, null, () => deps.configStore.getCached())

  handle(IPC.configSave, configSchema, async (config: ClientConfig) => {
    const previous = deps.configStore.getCached()
    const saved = await deps.configStore.save(config)
    if (
      previous.serverTicket !== saved.serverTicket ||
      previous.serverNodeId !== saved.serverNodeId ||
      previous.relayUrl !== saved.relayUrl
    ) {
      await deps.connection.disconnect()
    }
    return saved
  })

  handle(IPC.connectionStatus, null, () => deps.connection.getStatus())
  handle(IPC.connectionConnect, null, () => deps.connection.connect())
  handle(IPC.connectionDisconnect, null, async () => {
    await deps.connection.disconnect()
  })

  handle(IPC.sessionsList, null, () => deps.sessions.list())
  handle(IPC.sessionsCreate, null, () => deps.sessions.create())
  handle(IPC.sessionsActivate, sessionIdSchema, (sessionId: string) =>
    deps.sessions.activate(sessionId),
  )
  handle(IPC.sessionsGet, sessionIdSchema, (sessionId: string) =>
    deps.sessions.getSnapshot(sessionId),
  )
  handle(IPC.sessionsGetActive, null, () => deps.sessions.getActiveSnapshot())

  handle(IPC.promptSend, promptSchema, (input: PromptSubmission) => deps.prompts.sendPrompt(input))
  handle(IPC.promptCancel, null, () => deps.prompts.cancelPrompt())

  handle(IPC.clipboardWrite, copyTextSchema, (text: string) => {
    deps.copyText(text)
  })

  handle(IPC.noticesGet, null, () => deps.notices.map((message) => ({ level: 'warning' as const, message })))
}

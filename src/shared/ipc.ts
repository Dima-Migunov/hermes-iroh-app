import type {
  AppNotice,
  ClientConfig,
  ConnectionStatus,
  PromptEvent,
  SessionSnapshot,
  SessionSummary,
} from './protocol'

export const IPC = {
  identityGet: 'identity:get',
  configGet: 'config:get',
  configSave: 'config:save',
  connectionStatus: 'connection:status',
  connectionConnect: 'connection:connect',
  connectionDisconnect: 'connection:disconnect',
  sessionsList: 'sessions:list',
  sessionsCreate: 'sessions:create',
  sessionsActivate: 'sessions:activate',
  sessionsGet: 'sessions:get',
  sessionsGetActive: 'sessions:get-active',
  promptSend: 'prompt:send',
  promptCancel: 'prompt:cancel',
  clipboardWrite: 'clipboard:write',
  promptEvent: 'prompt:event',
  connectionStatusChanged: 'connection:status-changed',
  historyChanged: 'history:changed',
  notice: 'app:notice',
  noticesGet: 'app:notices',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface PromptSubmission {
  sessionId: string
  text: string
}

export interface PromptSubmissionResult {
  requestId: string
}

export interface IpcApi {
  getIdentity(): Promise<{ nodeId: string }>
  getConfig(): Promise<ClientConfig>
  saveConfig(config: ClientConfig): Promise<ClientConfig>
  getConnectionStatus(): Promise<ConnectionStatus>
  connect(): Promise<ConnectionStatus>
  disconnect(): Promise<void>
  listSessions(): Promise<SessionSummary[]>
  createSession(): Promise<SessionSummary>
  activateSession(id: string): Promise<SessionSnapshot>
  getSession(id: string): Promise<SessionSnapshot>
  getActiveSession(): Promise<SessionSnapshot>
  getNotices(): Promise<AppNotice[]>
  sendPrompt(input: PromptSubmission): Promise<PromptSubmissionResult>
  cancelPrompt(): Promise<boolean>
  copyText(text: string): Promise<void>
  onPromptEvent(handler: (event: PromptEvent) => void): () => void
  onConnectionStatus(handler: (status: ConnectionStatus) => void): () => void
  onHistoryChanged(handler: () => void): () => void
  onNotice(handler: (notice: AppNotice) => void): () => void
}

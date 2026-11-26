import type {
  AppNotice,
  ClientConfig,
  ConnectionStatus,
  PromptEvent,
  SessionDeletionResult,
  SessionSnapshot,
  SessionSummary,
} from './protocol'

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
  renameSession(id: string, title: string): Promise<SessionSummary>
  deleteSession(id: string): Promise<SessionDeletionResult>
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

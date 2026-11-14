export type ErrorCode =
  | 'busy'
  | 'timeout'
  | 'network'
  | 'connection-closed'
  | 'connection-refused'
  | 'protocol'
  | 'server'
  | 'identity'
  | 'configuration'
  | 'not-found'
  | 'internal'

export interface ClientConfig {
  serverTicket: string | null
  serverNodeId: string | null
  relayUrl: string | null
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionStatus {
  state: ConnectionState
  message?: string
}

export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'interrupted'

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  status: MessageStatus
  error?: {
    code: ErrorCode
    message: string
  }
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface SessionSnapshot {
  session: SessionSummary
  messages: StoredMessage[]
}

export interface ClientPromptFrame {
  type: 'prompt'
  session_id: string
  text: string
}

export type ServerFrame =
  | { type: 'start'; session_id: string }
  | { type: 'delta'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type PromptEvent =
  | { requestId: string; type: 'start'; sessionId: string }
  | { requestId: string; type: 'delta'; content: string }
  | { requestId: string; type: 'done'; sessionId: string }
  | { requestId: string; type: 'error'; sessionId: string; code: ErrorCode; message: string }

export interface AppNotice {
  level: 'info' | 'warning'
  message: string
}

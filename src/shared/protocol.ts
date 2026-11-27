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

export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  reasoning_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}

export interface SessionUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  api_calls?: number
  estimated_cost_usd?: number
  cost_status?: string
  cost_source?: string
  context_tokens?: number
  context_length?: number
  context_percent?: number
}

export interface PlanGauge {
  id?: string
  label?: string
  used_bp?: number
  resets_at_ms?: number
}

export interface AccountBalance {
  provider?: string
  remaining_micros?: number
  remaining_usd?: number
  subscription_micros?: number
  subscription_usd?: number
  subscription_limit_usd?: number
  purchased_micros?: number
  purchased_usd?: number
  paid_access?: boolean
  as_of_ms?: number
  plan_gauge?: PlanGauge
}

export interface ResponseMetadata {
  schema: number
  generated_at: string
  latency_ms: number
  model?: string
  provider?: string
  usage?: TokenUsage
  session_usage?: SessionUsage
  balance?: AccountBalance
}

export interface ToolCall {
  id?: string
  name: string
  arguments: Record<string, unknown>
  truncated?: boolean
  lineIndex: number
}

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  status: MessageStatus
  toolCalls?: ToolCall[]
  error?: {
    code: ErrorCode
    message: string
  }
  metadata?: ResponseMetadata
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  customTitle?: boolean
}

export interface SessionSnapshot {
  session: SessionSummary
  messages: StoredMessage[]
}

export interface SessionDeletionResult {
  sessions: SessionSummary[]
  activeSession: SessionSnapshot
}

export interface ClientPromptFrame {
  type: 'prompt'
  session_id: string
  text: string
}

export type ServerFrame =
  | { type: 'start'; session_id: string }
  | { type: 'delta'; content: string }
  | {
      type: 'tool'
      id?: string
      name: string
      arguments: Record<string, unknown>
      truncated?: boolean
    }
  | { type: 'done'; metadata?: ResponseMetadata }
  | { type: 'error'; message: string }

export type PromptEvent =
  | { requestId: string; type: 'start'; sessionId: string }
  | { requestId: string; type: 'delta'; content: string }
  | {
      requestId: string
      type: 'tool'
      sessionId: string
      id?: string
      name: string
      arguments: Record<string, unknown>
      truncated: boolean
      lineIndex: number
    }
  | { requestId: string; type: 'done'; sessionId: string; metadata?: ResponseMetadata }
  | { requestId: string; type: 'cancelled'; sessionId: string }
  | { requestId: string; type: 'error'; sessionId: string; code: ErrorCode; message: string }

export interface AppNotice {
  level: 'info' | 'warning'
  message: string
}

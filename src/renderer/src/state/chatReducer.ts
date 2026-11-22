import type {
  AppNotice,
  ClientConfig,
  ConnectionStatus,
  ErrorCode,
  PromptEvent,
  ResponseMetadata,
  SessionSnapshot,
  SessionSummary,
  StoredMessage,
} from '@shared/protocol'

export interface ChatState {
  identityNodeId: string | null
  config: ClientConfig | null
  connection: ConnectionStatus
  sessions: SessionSummary[]
  activeSessionId: string | null
  transcripts: Record<string, StoredMessage[]>
  activeRequestId: string | null
  activeAssistantId: string | null
  generating: boolean
  error: { code: ErrorCode; message: string } | null
  notices: AppNotice[]
}

export const initialChatState: ChatState = {
  identityNodeId: null,
  config: null,
  connection: { state: 'disconnected' },
  sessions: [],
  activeSessionId: null,
  transcripts: {},
  activeRequestId: null,
  activeAssistantId: null,
  generating: false,
  error: null,
  notices: [],
}

export type ChatAction =
  | {
      type: 'bootstrap'
      identityNodeId: string
      config: ClientConfig
      connection: ConnectionStatus
      sessions: SessionSummary[]
      snapshot: SessionSnapshot
      notices: AppNotice[]
    }
  | { type: 'connection/set'; status: ConnectionStatus }
  | { type: 'config/saved'; config: ClientConfig }
  | { type: 'sessions/set'; sessions: SessionSummary[] }
  | { type: 'session/created'; session: SessionSummary }
  | { type: 'session/activated'; snapshot: SessionSnapshot }
  | {
      type: 'prompt/sent'
      sessionId: string
      text: string
      messageId: string
      createdAt: string
    }
  | { type: 'prompt/request'; requestId: string }
  | { type: 'prompt/start'; requestId: string; createdAt: string }
  | {
      type: 'prompt/delta'
      requestId: string
      chunks: string[]
      createdAt: string
    }
  | { type: 'prompt/done'; requestId: string; metadata?: ResponseMetadata }
  | { type: 'prompt/cancelled'; requestId: string }
  | {
      type: 'prompt/error'
      requestId: string
      sessionId: string
      code: ErrorCode
      message: string
    }
  | { type: 'error/dismiss' }
  | { type: 'notice/add'; notice: AppNotice }
  | { type: 'notice/dismiss'; index: number }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'bootstrap':
      return {
        ...state,
        identityNodeId: action.identityNodeId,
        config: action.config,
        connection: action.connection,
        sessions: action.sessions,
        activeSessionId: action.snapshot.session.id,
        transcripts: {
          ...state.transcripts,
          [action.snapshot.session.id]: action.snapshot.messages,
        },
        notices: action.notices,
      }

    case 'connection/set':
      return { ...state, connection: action.status }

    case 'config/saved':
      return { ...state, config: action.config }

    case 'sessions/set': {
      const activeSessionId =
        state.activeSessionId &&
        action.sessions.some((session) => session.id === state.activeSessionId)
          ? state.activeSessionId
          : (action.sessions[0]?.id ?? null)
      return { ...state, sessions: action.sessions, activeSessionId }
    }

    case 'session/created':
      return {
        ...state,
        sessions: [action.session, ...state.sessions.filter((item) => item.id !== action.session.id)],
        activeSessionId: action.session.id,
        transcripts: { ...state.transcripts, [action.session.id]: [] },
        error: null,
      }

    case 'session/activated': {
      if (state.generating) return state
      return {
        ...state,
        activeSessionId: action.snapshot.session.id,
        transcripts: {
          ...state.transcripts,
          [action.snapshot.session.id]: action.snapshot.messages,
        },
        error: null,
      }
    }

    case 'prompt/sent': {
      if (state.generating) return state
      const messages = state.transcripts[action.sessionId] ?? []
      const userMessage: StoredMessage = {
        id: action.messageId,
        role: 'user',
        content: action.text,
        createdAt: action.createdAt,
        status: 'complete',
      }
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.sessionId]: [...messages, userMessage],
        },
        activeRequestId: 'pending',
        activeAssistantId: null,
        generating: true,
        error: null,
      }
    }

    case 'prompt/request': {
      if (!state.generating || state.activeRequestId !== 'pending') return state
      return { ...state, activeRequestId: action.requestId }
    }

    case 'prompt/start': {
      if (!state.generating) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      if (state.activeAssistantId) return { ...state, activeRequestId: action.requestId }

      const sessionId = state.activeSessionId
      if (!sessionId) return state
      const messages = state.transcripts[sessionId] ?? []
      const assistantMessage: StoredMessage = {
        id: `assistant-${action.requestId}`,
        role: 'assistant',
        content: '',
        createdAt: action.createdAt,
        status: 'streaming',
      }
      return {
        ...state,
        activeRequestId: action.requestId,
        activeAssistantId: assistantMessage.id,
        transcripts: {
          ...state.transcripts,
          [sessionId]: [...messages, assistantMessage],
        },
      }
    }

    case 'prompt/delta': {
      if (!state.generating) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      const sessionId = state.activeSessionId
      if (!sessionId) return state
      const content = action.chunks.join('')
      if (content.length === 0) return state

      const messages = state.transcripts[sessionId] ?? []
      const assistantId = state.activeAssistantId ?? `assistant-${action.requestId}`
      const existingIndex = messages.findIndex((message) => message.id === assistantId)

      if (existingIndex === -1) {
        const assistantMessage: StoredMessage = {
          id: assistantId,
          role: 'assistant',
          content,
          createdAt: action.createdAt,
          status: 'streaming',
        }
        return {
          ...state,
          activeRequestId: action.requestId,
          activeAssistantId: assistantId,
          transcripts: {
            ...state.transcripts,
            [sessionId]: [...messages, assistantMessage],
          },
        }
      }

      const updated = messages.map((message, index) =>
        index === existingIndex ? { ...message, content: message.content + content } : message,
      )
      return {
        ...state,
        activeRequestId: action.requestId,
        transcripts: { ...state.transcripts, [sessionId]: updated },
      }
    }

    case 'prompt/done': {
      if (!state.generating) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      return finishGeneration(state, (message) => ({
        ...message,
        status: 'complete',
        ...(action.metadata ? { metadata: action.metadata } : {}),
      }))
    }

    case 'prompt/cancelled': {
      if (!state.generating) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }

      const sessionId = state.activeSessionId
      const assistantId = state.activeAssistantId
      if (!sessionId || !assistantId) {
        return { ...state, generating: false, activeRequestId: null, activeAssistantId: null }
      }

      const messages = state.transcripts[sessionId] ?? []
      const updated = messages.map((message) =>
        message.id === assistantId && message.status === 'streaming'
          ? { ...message, status: 'interrupted' as const }
          : message,
      )

      return {
        ...state,
        transcripts: { ...state.transcripts, [sessionId]: updated },
        generating: false,
        activeRequestId: null,
        activeAssistantId: null,
      }
    }

    case 'prompt/error': {
      if (!state.generating) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      const error = { code: action.code, message: action.message }
      const withFailedAssistant = finishGeneration(state, (message) => ({
        ...message,
        status: 'failed',
        error,
      }))
      const sessionId = withFailedAssistant.activeSessionId
      if (!sessionId) return { ...withFailedAssistant, error }

      const messages = withFailedAssistant.transcripts[sessionId] ?? []
      const lastUserIndex = [...messages]
        .map((message, index) => ({ message, index }))
        .reverse()
        .find((entry) => entry.message.role === 'user')?.index

      const updated: StoredMessage[] =
        lastUserIndex === undefined
          ? messages
          : messages.map((message, index) =>
              index === lastUserIndex
                ? { ...message, status: 'failed' as const, error }
                : message,
            )

      return {
        ...withFailedAssistant,
        error,
        transcripts: { ...withFailedAssistant.transcripts, [sessionId]: updated },
      }
    }

    case 'error/dismiss':
      return { ...state, error: null }

    case 'notice/add':
      if (state.notices.some((notice) => notice.message === action.notice.message)) return state
      return { ...state, notices: [...state.notices, action.notice] }

    case 'notice/dismiss':
      return {
        ...state,
        notices: state.notices.filter((_notice, index) => index !== action.index),
      }
  }
}

function finishGeneration(
  state: ChatState,
  updateAssistant: (message: StoredMessage) => StoredMessage,
): ChatState {
  const sessionId = state.activeSessionId
  if (!sessionId) return { ...state, generating: false, activeRequestId: null }

  const messages = state.transcripts[sessionId] ?? []
  let updated = messages.map((message) =>
    message.id === state.activeAssistantId ? updateAssistant(message) : message,
  )

  if (state.activeAssistantId === null) {
    const lastUserIndex = [...updated]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find((entry) => entry.message.role === 'user')?.index

    if (lastUserIndex !== undefined) {
      updated = updated.map((message, index) =>
        index === lastUserIndex ? updateAssistant(message) : message,
      )
    }
  }

  return {
    ...state,
    transcripts: { ...state.transcripts, [sessionId]: updated },
    generating: false,
    activeRequestId: null,
    activeAssistantId: null,
  }
}

export function selectActiveMessages(state: ChatState): StoredMessage[] {
  if (!state.activeSessionId) return []
  return state.transcripts[state.activeSessionId] ?? []
}

export function selectLatestResponseMetadata(state: ChatState): ResponseMetadata | undefined {
  const messages = selectActiveMessages(state)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.status === 'complete' && message.metadata) {
      return message.metadata
    }
  }
  return undefined
}

export function applyPromptEventToState(
  state: ChatState,
  event: PromptEvent,
  createdAt: string,
): ChatState {
  switch (event.type) {
    case 'start':
      return chatReducer(state, { type: 'prompt/start', requestId: event.requestId, createdAt })
    case 'delta':
      return chatReducer(state, {
        type: 'prompt/delta',
        requestId: event.requestId,
        chunks: [event.content],
        createdAt,
      })
    case 'done':
      return chatReducer(state, {
        type: 'prompt/done',
        requestId: event.requestId,
        metadata: event.metadata,
      })
    case 'cancelled':
      return chatReducer(state, { type: 'prompt/cancelled', requestId: event.requestId })
    case 'error':
      return chatReducer(state, {
        type: 'prompt/error',
        requestId: event.requestId,
        sessionId: event.sessionId,
        code: event.code,
        message: event.message,
      })
  }
}

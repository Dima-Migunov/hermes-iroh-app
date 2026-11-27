import type {
  AppNotice,
  ClientConfig,
  ConnectionStatus,
  ErrorCode,
  PromptEvent,
  ResponseMetadata,
  SessionDeletionResult,
  SessionSnapshot,
  SessionSummary,
  StoredMessage,
  ToolCall,
} from '@shared/protocol'

export interface NoticeEntry extends AppNotice {
  id: string
}

export interface ChatState {
  identityNodeId: string | null
  config: ClientConfig | null
  connection: ConnectionStatus
  sessions: SessionSummary[]
  activeSessionId: string | null
  transcripts: Record<string, StoredMessage[]>
  transcriptOrder: string[]
  activeRequestId: string | null
  activeRequestSessionId: string | null
  activeAssistantId: string | null
  generating: boolean
  error: { code: ErrorCode; message: string } | null
  notices: NoticeEntry[]
}

export const MAX_CACHED_TRANSCRIPTS = 4
export const MAX_NOTICES = 20

const EMPTY_MESSAGES: StoredMessage[] = []

export const initialChatState: ChatState = {
  identityNodeId: null,
  config: null,
  connection: { state: 'disconnected' },
  sessions: [],
  activeSessionId: null,
  transcripts: {},
  transcriptOrder: [],
  activeRequestId: null,
  activeRequestSessionId: null,
  activeAssistantId: null,
  generating: false,
  error: null,
  notices: [],
}

let noticeSequence = 0

function nextNoticeId(): string {
  noticeSequence += 1
  return `notice-${noticeSequence}`
}

export type ChatAction =
  | {
      type: 'bootstrap'
      identityNodeId: string | null
      config: ClientConfig | null
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
  | { type: 'session/renamed'; session: SessionSummary }
  | { type: 'session/deleted'; result: SessionDeletionResult }
  | {
      type: 'prompt/sent'
      sessionId: string
      text: string
      messageId: string
      createdAt: string
    }
  | { type: 'prompt/request'; requestId: string }
  | { type: 'prompt/start'; requestId: string; sessionId: string; createdAt: string }
  | {
      type: 'prompt/delta'
      requestId: string
      chunks: string[]
      createdAt: string
    }
  | {
      type: 'prompt/tool'
      requestId: string
      sessionId: string
      toolCall: ToolCall
      createdAt: string
    }
  | {
      type: 'prompt/done'
      requestId: string
      sessionId: string
      metadata?: ResponseMetadata
    }
  | { type: 'prompt/cancelled'; requestId: string; sessionId: string }
  | {
      type: 'prompt/error'
      requestId: string
      sessionId: string
      code: ErrorCode
      message: string
    }
  | { type: 'error/dismiss' }
  | { type: 'notice/add'; notice: AppNotice }
  | { type: 'notice/dismiss'; id: string }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'bootstrap': {
      const sessionId = action.snapshot.session.id
      const cached = rememberTranscript(
        { ...state, activeSessionId: sessionId },
        sessionId,
        action.snapshot.messages,
      )
      return {
        ...state,
        identityNodeId: action.identityNodeId,
        config: action.config,
        connection: action.connection,
        sessions: action.sessions,
        activeSessionId: sessionId,
        transcripts: cached.transcripts,
        transcriptOrder: cached.transcriptOrder,
        notices: mergeNotices(state.notices, action.notices),
      }
    }

    case 'connection/set':
      return { ...state, connection: action.status }

    case 'config/saved':
      return { ...state, config: action.config }

    case 'sessions/set':
      return { ...state, sessions: action.sessions }

    case 'session/created': {
      if (state.generating) return state
      const cached = rememberTranscript(
        { ...state, activeSessionId: action.session.id },
        action.session.id,
        EMPTY_MESSAGES,
      )
      return {
        ...state,
        sessions: [action.session, ...state.sessions.filter((item) => item.id !== action.session.id)],
        activeSessionId: action.session.id,
        transcripts: cached.transcripts,
        transcriptOrder: cached.transcriptOrder,
        error: null,
      }
    }

    case 'session/activated': {
      if (state.generating) return state
      const sessionId = action.snapshot.session.id
      const cached = rememberTranscript(
        { ...state, activeSessionId: sessionId },
        sessionId,
        action.snapshot.messages,
      )
      return {
        ...state,
        activeSessionId: sessionId,
        transcripts: cached.transcripts,
        transcriptOrder: cached.transcriptOrder,
        error: null,
      }
    }

    case 'session/renamed':
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === action.session.id ? action.session : session,
        ),
      }

    case 'session/deleted': {
      if (state.generating) return state
      const remaining = new Set(action.result.sessions.map((session) => session.id))
      const activeId = action.result.activeSession.session.id
      const transcripts: Record<string, StoredMessage[]> = {}
      for (const [id, messages] of Object.entries(state.transcripts)) {
        if (remaining.has(id)) transcripts[id] = messages
      }
      const transcriptOrder = state.transcriptOrder.filter((id) => remaining.has(id))
      const cached = rememberTranscript(
        { ...state, transcripts, transcriptOrder, activeSessionId: activeId },
        activeId,
        action.result.activeSession.messages,
      )
      return {
        ...state,
        sessions: action.result.sessions,
        activeSessionId: activeId,
        transcripts: cached.transcripts,
        transcriptOrder: cached.transcriptOrder,
        error: null,
      }
    }

    case 'prompt/sent': {
      if (state.generating) return state
      const userMessage: StoredMessage = {
        id: action.messageId,
        role: 'user',
        content: action.text,
        createdAt: action.createdAt,
        status: 'complete',
      }
      const generatingState: ChatState = {
        ...state,
        activeRequestId: 'pending',
        activeRequestSessionId: action.sessionId,
        activeAssistantId: null,
        generating: true,
        error: null,
      }
      const messages = state.transcripts[action.sessionId] ?? EMPTY_MESSAGES
      const cached = rememberTranscript(
        generatingState,
        action.sessionId,
        [...messages, userMessage],
      )
      return {
        ...generatingState,
        transcripts: cached.transcripts,
        transcriptOrder: cached.transcriptOrder,
      }
    }

    case 'prompt/request': {
      if (!state.generating || state.activeRequestId !== 'pending') return state
      return { ...state, activeRequestId: action.requestId }
    }

    case 'prompt/start': {
      if (!state.generating) return state
      if (action.sessionId !== state.activeRequestSessionId) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      if (state.activeAssistantId) return state

      const messages = state.transcripts[action.sessionId] ?? EMPTY_MESSAGES
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
          [action.sessionId]: [...messages, assistantMessage],
        },
      }
    }

    case 'prompt/delta': {
      if (!state.generating) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      const sessionId = state.activeRequestSessionId
      if (!sessionId) return state
      const content = action.chunks.join('')
      if (content.length === 0) return state

      const messages = state.transcripts[sessionId] ?? EMPTY_MESSAGES
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

    case 'prompt/tool': {
      if (!state.generating) return state
      if (action.sessionId !== state.activeRequestSessionId) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      const sessionId = state.activeRequestSessionId
      const assistantId = state.activeAssistantId ?? `assistant-${action.requestId}`
      const messages = state.transcripts[sessionId] ?? EMPTY_MESSAGES
      const existingIndex = messages.findIndex((message) => message.id === assistantId)

      if (existingIndex === -1) {
        const assistantMessage: StoredMessage = {
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: action.createdAt,
          status: 'streaming',
          toolCalls: [action.toolCall],
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

      const target = messages[existingIndex]
      const existingCalls = target.toolCalls ?? []
      if (
        action.toolCall.id !== undefined &&
        existingCalls.some((call) => call.id === action.toolCall.id)
      ) {
        return state
      }

      const updated = messages.map((message, index) =>
        index === existingIndex
          ? { ...message, toolCalls: [...existingCalls, action.toolCall] }
          : message,
      )
      return {
        ...state,
        activeRequestId: action.requestId,
        transcripts: { ...state.transcripts, [sessionId]: updated },
      }
    }

    case 'prompt/done': {
      if (!state.generating) return state
      if (action.sessionId !== state.activeRequestSessionId) return state
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
      if (action.sessionId !== state.activeRequestSessionId) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }

      const sessionId = state.activeRequestSessionId
      const assistantId = state.activeAssistantId
      if (!sessionId || !assistantId) {
        return {
          ...state,
          generating: false,
          activeRequestId: null,
          activeRequestSessionId: null,
          activeAssistantId: null,
        }
      }

      const messages = state.transcripts[sessionId] ?? EMPTY_MESSAGES
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
        activeRequestSessionId: null,
        activeAssistantId: null,
      }
    }

    case 'prompt/error': {
      if (!state.generating) return state
      if (action.sessionId !== state.activeRequestSessionId) return state
      if (state.activeRequestId !== 'pending' && state.activeRequestId !== action.requestId) {
        return state
      }
      const error = { code: action.code, message: action.message }
      const withFailedAssistant = finishGeneration(state, (message) => ({
        ...message,
        status: 'failed',
        error,
      }))

      const messages = withFailedAssistant.transcripts[action.sessionId] ?? EMPTY_MESSAGES
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
        transcripts: { ...withFailedAssistant.transcripts, [action.sessionId]: updated },
      }
    }

    case 'error/dismiss':
      return { ...state, error: null }

    case 'notice/add':
      return { ...state, notices: appendNotice(state.notices, action.notice) }

    case 'notice/dismiss':
      return {
        ...state,
        notices: state.notices.filter((notice) => notice.id !== action.id),
      }
  }
}

function appendNotice(notices: NoticeEntry[], notice: AppNotice): NoticeEntry[] {
  if (notices.some((entry) => entry.message === notice.message)) return notices
  const next = [...notices, { ...notice, id: nextNoticeId() }]
  return next.length > MAX_NOTICES ? next.slice(next.length - MAX_NOTICES) : next
}

function mergeNotices(current: NoticeEntry[], arriving: AppNotice[]): NoticeEntry[] {
  let notices = current
  for (const notice of arriving) notices = appendNotice(notices, notice)
  return notices
}

interface CachedTranscripts {
  transcripts: Record<string, StoredMessage[]>
  transcriptOrder: string[]
}

function rememberTranscript(
  state: ChatState,
  sessionId: string,
  messages: StoredMessage[],
): CachedTranscripts {
  const order = [sessionId, ...state.transcriptOrder.filter((id) => id !== sessionId)]
  const retained = new Set(order.slice(0, MAX_CACHED_TRANSCRIPTS))
  if (state.activeSessionId) retained.add(state.activeSessionId)
  if (state.activeRequestSessionId) retained.add(state.activeRequestSessionId)

  const nextTranscripts: Record<string, StoredMessage[]> = {
    ...state.transcripts,
    [sessionId]: messages,
  }
  for (const id of Object.keys(nextTranscripts)) {
    if (!retained.has(id)) delete nextTranscripts[id]
  }

  return {
    transcripts: nextTranscripts,
    transcriptOrder: order.filter((id) => retained.has(id)),
  }
}

function finishGeneration(
  state: ChatState,
  updateAssistant: (message: StoredMessage) => StoredMessage,
): ChatState {
  const sessionId = state.activeRequestSessionId
  const assistantId = state.activeAssistantId

  if (!sessionId || !assistantId) {
    return {
      ...state,
      generating: false,
      activeRequestId: null,
      activeRequestSessionId: null,
      activeAssistantId: null,
    }
  }

  const messages = state.transcripts[sessionId] ?? EMPTY_MESSAGES
  const updated = messages.map((message) =>
    message.id === assistantId ? updateAssistant(message) : message,
  )

  return {
    ...state,
    transcripts: { ...state.transcripts, [sessionId]: updated },
    generating: false,
    activeRequestId: null,
    activeRequestSessionId: null,
    activeAssistantId: null,
  }
}

export function selectActiveMessages(state: ChatState): StoredMessage[] {
  if (!state.activeSessionId) return EMPTY_MESSAGES
  return state.transcripts[state.activeSessionId] ?? EMPTY_MESSAGES
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
      return chatReducer(state, {
        type: 'prompt/start',
        requestId: event.requestId,
        sessionId: event.sessionId,
        createdAt,
      })
    case 'delta':
      return chatReducer(state, {
        type: 'prompt/delta',
        requestId: event.requestId,
        chunks: [event.content],
        createdAt,
      })
    case 'tool':
      return chatReducer(state, {
        type: 'prompt/tool',
        requestId: event.requestId,
        sessionId: event.sessionId,
        toolCall: {
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          truncated: event.truncated,
          lineIndex: event.lineIndex,
        },
        createdAt,
      })
    case 'done':
      return chatReducer(state, {
        type: 'prompt/done',
        requestId: event.requestId,
        sessionId: event.sessionId,
        metadata: event.metadata,
      })
    case 'cancelled':
      return chatReducer(state, {
        type: 'prompt/cancelled',
        requestId: event.requestId,
        sessionId: event.sessionId,
      })
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

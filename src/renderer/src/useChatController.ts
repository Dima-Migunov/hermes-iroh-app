import { useCallback, useEffect, useReducer, useRef } from 'react'
import type {
  ClientConfig,
  ErrorCode,
  PromptEvent,
  ResponseMetadata,
  StoredMessage,
} from '@shared/protocol'
import { bridge } from './bridge'
import {
  chatReducer,
  initialChatState,
  selectActiveMessages,
  selectLatestResponseMetadata,
  type ChatState,
} from './state/chatReducer'

const DELTA_FLUSH_MS = 50

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'An unexpected error occurred.'
}

function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof Error) {
    const code = (error as unknown as { code?: unknown }).code
    if (typeof code === 'string') return code as ErrorCode
  }
  return 'internal'
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`
}

export interface ChatController {
  state: ChatState
  messages: StoredMessage[]
  latestMetadata: ResponseMetadata | undefined
  sendPrompt(text: string): Promise<boolean>
  cancelPrompt(): Promise<void>
  createSession(): Promise<void>
  activateSession(id: string): Promise<void>
  saveAndConnect(config: ClientConfig): Promise<ClientConfig>
  copyText(text: string): Promise<void>
  dismissError(): void
  dismissNotice(id: string): void
}

interface PendingDelta {
  requestId: string
  content: string
}

export function useChatController(): ChatController {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  const stateRef = useRef(state)
  stateRef.current = state

  const selectionSeq = useRef(0)
  const listSeq = useRef(0)
  const submitting = useRef(false)

  useEffect(() => {
    const api = bridge

    let cancelled = false
    let frameId: number | null = null
    let timerId: ReturnType<typeof setTimeout> | null = null
    const pendingDeltas: PendingDelta[] = []

    const cancelScheduledFlush = (): void => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
        frameId = null
      }
      if (timerId !== null) {
        clearTimeout(timerId)
        timerId = null
      }
    }

    const flushDeltas = (): void => {
      frameId = null
      timerId = null
      if (pendingDeltas.length === 0) return

      const grouped = new Map<string, string[]>()
      for (const item of pendingDeltas) {
        const chunks = grouped.get(item.requestId) ?? []
        chunks.push(item.content)
        grouped.set(item.requestId, chunks)
      }
      pendingDeltas.length = 0

      const createdAt = new Date().toISOString()
      for (const [requestId, chunks] of grouped) {
        dispatch({ type: 'prompt/delta', requestId, chunks, createdAt })
      }
    }

    const scheduleFlush = (): void => {
      if (frameId !== null || timerId !== null) return
      frameId = requestAnimationFrame(flushDeltas)
      timerId = setTimeout(flushDeltas, DELTA_FLUSH_MS)
    }

    const flushNow = (): void => {
      cancelScheduledFlush()
      flushDeltas()
    }

    const handlePromptEvent = (event: PromptEvent): void => {
      if (cancelled) return

      if (event.type === 'delta') {
        pendingDeltas.push({ requestId: event.requestId, content: event.content })
        scheduleFlush()
        return
      }

      flushNow()
      const createdAt = new Date().toISOString()

      switch (event.type) {
        case 'start':
          dispatch({
            type: 'prompt/start',
            requestId: event.requestId,
            sessionId: event.sessionId,
            createdAt,
          })
          break
        case 'done':
          dispatch({
            type: 'prompt/done',
            requestId: event.requestId,
            sessionId: event.sessionId,
            metadata: event.metadata,
          })
          break
        case 'cancelled':
          dispatch({
            type: 'prompt/cancelled',
            requestId: event.requestId,
            sessionId: event.sessionId,
          })
          break
        case 'error':
          dispatch({
            type: 'prompt/error',
            requestId: event.requestId,
            sessionId: event.sessionId,
            code: event.code,
            message: event.message,
          })
          break
      }
    }

    const refreshSessions = (): void => {
      const sequence = ++listSeq.current
      void api
        .listSessions()
        .then((sessions) => {
          if (cancelled || sequence !== listSeq.current) return
          dispatch({ type: 'sessions/set', sessions })
        })
        .catch(() => undefined)
    }

    const unsubscribePrompt = api.onPromptEvent(handlePromptEvent)
    const unsubscribeStatus = api.onConnectionStatus((status) =>
      dispatch({ type: 'connection/set', status }),
    )
    const unsubscribeHistory = api.onHistoryChanged(refreshSessions)
    const unsubscribeNotice = api.onNotice((notice) =>
      dispatch({ type: 'notice/add', notice }),
    )

    void (async () => {
      const [identity, config, connection, sessions, snapshot, notices] =
        await Promise.allSettled([
          api.getIdentity(),
          api.getConfig(),
          api.getConnectionStatus(),
          api.listSessions(),
          api.getActiveSession(),
          api.getNotices(),
        ])
      if (cancelled) return

      const failures = [identity, config, connection, sessions, snapshot, notices]
        .filter((result) => result.status === 'rejected')
        .map((result) => messageOf((result as PromiseRejectedResult).reason))

      for (const message of failures) {
        dispatch({ type: 'notice/add', notice: { level: 'warning', message } })
      }

      if (snapshot.status === 'rejected') return

      dispatch({
        type: 'bootstrap',
        identityNodeId: identity.status === 'fulfilled' ? identity.value.nodeId : null,
        config: config.status === 'fulfilled' ? config.value : null,
        connection:
          connection.status === 'fulfilled'
            ? connection.value
            : initialChatState.connection,
        sessions: sessions.status === 'fulfilled' ? sessions.value : [],
        snapshot: snapshot.value,
        notices: notices.status === 'fulfilled' ? notices.value : [],
      })
    })()

    return () => {
      cancelled = true
      cancelScheduledFlush()
      unsubscribePrompt()
      unsubscribeStatus()
      unsubscribeHistory()
      unsubscribeNotice()
    }
  }, [])

  const sendPrompt = useCallback(async (text: string): Promise<boolean> => {
    const api = bridge
    const current = stateRef.current
    if (!current.activeSessionId || text.trim().length === 0 || current.generating) {
      return false
    }
    if (submitting.current) return false
    submitting.current = true

    const sessionId = current.activeSessionId
    const createdAt = new Date().toISOString()
    const requestId = `pending-${createId()}`
    dispatch({
      type: 'prompt/sent',
      sessionId,
      text,
      messageId: `local-${createId()}`,
      createdAt,
    })

    try {
      const result = await api.sendPrompt({ sessionId, text })
      dispatch({ type: 'prompt/request', requestId: result.requestId })
    } catch (error) {
      dispatch({
        type: 'prompt/error',
        requestId,
        sessionId,
        code: errorCodeOf(error),
        message: messageOf(error),
      })
    } finally {
      submitting.current = false
    }

    return true
  }, [])

  const cancelPrompt = useCallback(async (): Promise<void> => {
    const api = bridge
    if (!stateRef.current.generating) return
    try {
      await api.cancelPrompt()
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const createSession = useCallback(async (): Promise<void> => {
    const api = bridge
    if (stateRef.current.generating) return
    const sequence = ++selectionSeq.current
    try {
      const session = await api.createSession()
      if (sequence !== selectionSeq.current) return
      dispatch({ type: 'session/created', session })
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const activateSession = useCallback(async (id: string): Promise<void> => {
    const api = bridge
    const current = stateRef.current
    if (current.generating || current.activeSessionId === id) return
    const sequence = ++selectionSeq.current
    try {
      const snapshot = await api.activateSession(id)
      if (sequence !== selectionSeq.current) return
      dispatch({ type: 'session/activated', snapshot })
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const saveAndConnect = useCallback(async (config: ClientConfig): Promise<ClientConfig> => {
    const api = bridge
    const saved = await api.saveConfig(config)
    dispatch({ type: 'config/saved', config: saved })
    const status = await api.connect()
    dispatch({ type: 'connection/set', status })
    return saved
  }, [])

  const copyText = useCallback(async (text: string): Promise<void> => {
    const api = bridge
    try {
      await api.copyText(text)
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const dismissError = useCallback(() => dispatch({ type: 'error/dismiss' }), [])
  const dismissNotice = useCallback(
    (id: string) => dispatch({ type: 'notice/dismiss', id }),
    [],
  )

  return {
    state,
    messages: selectActiveMessages(state),
    latestMetadata: selectLatestResponseMetadata(state),
    sendPrompt,
    cancelPrompt,
    createSession,
    activateSession,
    saveAndConnect,
    copyText,
    dismissError,
    dismissNotice,
  }
}

import { useCallback, useEffect, useReducer, useRef } from 'react'
import type {
  ClientConfig,
  PromptEvent,
  ResponseMetadata,
  StoredMessage,
} from '@shared/protocol'
import {
  chatReducer,
  initialChatState,
  selectActiveMessages,
  selectLatestResponseMetadata,
  type ChatState,
} from './state/chatReducer'

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'An unexpected error occurred.'
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
  dismissNotice(index: number): void
}

export function useChatController(): ChatController {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const api = window.irohChannel
    if (!api) {
      dispatch({
        type: 'notice/add',
        notice: {
          level: 'warning',
          message: 'The desktop bridge is unavailable. Restart the application.',
        },
      })
      return
    }

    let cancelled = false
    let frameId: number | null = null
    const pendingDeltas: Array<{ requestId: string; content: string }> = []

    const flushDeltas = (): void => {
      frameId = null
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

    const flushNow = (): void => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
        frameId = null
      }
      flushDeltas()
    }

    const handlePromptEvent = (event: PromptEvent): void => {
      if (cancelled) return

      if (event.type === 'delta') {
        pendingDeltas.push({ requestId: event.requestId, content: event.content })
        if (frameId === null) frameId = requestAnimationFrame(flushDeltas)
        return
      }

      flushNow()
      const createdAt = new Date().toISOString()

      switch (event.type) {
        case 'start':
          dispatch({ type: 'prompt/start', requestId: event.requestId, createdAt })
          break
        case 'done':
          dispatch({
            type: 'prompt/done',
            requestId: event.requestId,
            metadata: event.metadata,
          })
          break
        case 'cancelled':
          dispatch({ type: 'prompt/cancelled', requestId: event.requestId })
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

    const unsubscribePrompt = api.onPromptEvent(handlePromptEvent)
    const unsubscribeStatus = api.onConnectionStatus((status) =>
      dispatch({ type: 'connection/set', status }),
    )
    const unsubscribeHistory = api.onHistoryChanged(() => {
      void api
        .listSessions()
        .then((sessions) => {
          if (!cancelled) dispatch({ type: 'sessions/set', sessions })
        })
        .catch(() => undefined)
    })
    const unsubscribeNotice = api.onNotice((notice) =>
      dispatch({ type: 'notice/add', notice }),
    )

    void (async () => {
      try {
        const [identity, config, connection, sessions, snapshot, notices] = await Promise.all([
          api.getIdentity(),
          api.getConfig(),
          api.getConnectionStatus(),
          api.listSessions(),
          api.getActiveSession(),
          api.getNotices(),
        ])
        if (cancelled) return
        dispatch({
          type: 'bootstrap',
          identityNodeId: identity.nodeId,
          config,
          connection,
          sessions,
          snapshot,
          notices,
        })
      } catch (error) {
        if (cancelled) return
        dispatch({
          type: 'notice/add',
          notice: { level: 'warning', message: messageOf(error) },
        })
      }
    })()

    return () => {
      cancelled = true
      if (frameId !== null) cancelAnimationFrame(frameId)
      unsubscribePrompt()
      unsubscribeStatus()
      unsubscribeHistory()
      unsubscribeNotice()
    }
  }, [])

  const sendPrompt = useCallback(async (text: string): Promise<boolean> => {
    const api = window.irohChannel
    const current = stateRef.current
    if (!api || !current.activeSessionId || text.trim().length === 0 || current.generating) {
      return false
    }

    const sessionId = current.activeSessionId
    dispatch({
      type: 'prompt/sent',
      sessionId,
      text,
      messageId: `local-${createId()}`,
      createdAt: new Date().toISOString(),
    })

    try {
      const result = await api.sendPrompt({ sessionId, text })
      dispatch({ type: 'prompt/request', requestId: result.requestId })
    } catch (error) {
      dispatch({
        type: 'prompt/error',
        requestId: stateRef.current.activeRequestId ?? 'pending',
        sessionId,
        code: 'internal',
        message: messageOf(error),
      })
    }

    return true
  }, [])

  const cancelPrompt = useCallback(async (): Promise<void> => {
    const api = window.irohChannel
    if (!api || !stateRef.current.generating) return
    try {
      await api.cancelPrompt()
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const createSession = useCallback(async (): Promise<void> => {
    const api = window.irohChannel
    if (!api || stateRef.current.generating) return
    try {
      const session = await api.createSession()
      dispatch({ type: 'session/created', session })
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const activateSession = useCallback(async (id: string): Promise<void> => {
    const api = window.irohChannel
    const current = stateRef.current
    if (!api || current.generating || current.activeSessionId === id) return
    try {
      const snapshot = await api.activateSession(id)
      dispatch({ type: 'session/activated', snapshot })
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const saveAndConnect = useCallback(async (config: ClientConfig): Promise<ClientConfig> => {
    const api = window.irohChannel
    if (!api) throw new Error('The desktop bridge is unavailable.')

    const saved = await api.saveConfig(config)
    dispatch({ type: 'config/saved', config: saved })
    const status = await api.connect()
    dispatch({ type: 'connection/set', status })
    return saved
  }, [])

  const copyText = useCallback(async (text: string): Promise<void> => {
    const api = window.irohChannel
    if (!api) return
    try {
      await api.copyText(text)
    } catch (error) {
      dispatch({ type: 'notice/add', notice: { level: 'warning', message: messageOf(error) } })
    }
  }, [])

  const dismissError = useCallback(() => dispatch({ type: 'error/dismiss' }), [])
  const dismissNotice = useCallback(
    (index: number) => dispatch({ type: 'notice/dismiss', index }),
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

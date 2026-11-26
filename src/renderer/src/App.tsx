import { useCallback, useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { Composer } from './components/Composer'
import { SettingsPage } from './components/SettingsPage'
import { Sidebar } from './components/Sidebar'
import { Transcript } from './components/Transcript'
import { isCancelKey } from './composer'
import { formatWindowTitle } from './connection'
import { useChatController } from './useChatController'
import { useMediaQuery } from './useMediaQuery'
import { useSidebarState } from './useSidebarState'

type ActiveView = 'chat' | 'settings'

const COMPACT_BREAKPOINT = '(max-width: 720px)'

export default function App() {
  const chat = useChatController()
  const { state, cancelPrompt } = chat
  const [activeView, setActiveView] = useState<ActiveView>('chat')
  const [version, setVersion] = useState<string | null>(null)
  const compact = useMediaQuery(COMPACT_BREAKPOINT)
  const sidebar = useSidebarState(compact)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const returnFocusToSettingsRef = useRef(false)
  const wasExpandedRef = useRef(sidebar.expanded)

  useEffect(() => {
    let active = true
    void getVersion()
      .then((value) => {
        if (active) setVersion(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!version) return
    document.title = formatWindowTitle(state.connection.state, version)
  }, [state.connection.state, version])

  useEffect(() => {
    if (activeView === 'settings' || !returnFocusToSettingsRef.current) return
    returnFocusToSettingsRef.current = false
    settingsButtonRef.current?.focus()
  }, [activeView])

  useEffect(() => {
    const wasExpanded = wasExpandedRef.current
    wasExpandedRef.current = sidebar.expanded
    if (wasExpanded && !sidebar.expanded) {
      sidebarToggleRef.current?.focus()
    }
  }, [sidebar.expanded])

  useEffect(() => {
    if (!state.generating) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isCancelKey({ key: event.key, isComposing: event.isComposing })) return
      event.preventDefault()
      void cancelPrompt()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [state.generating, cancelPrompt])

  const closeSettings = useCallback((): void => {
    returnFocusToSettingsRef.current = true
    setActiveView('chat')
  }, [])

  const openSettings = useCallback((): void => {
    sidebar.close()
    setActiveView('settings')
  }, [sidebar])

  const handleSessionCreate = useCallback((): void => {
    sidebar.close()
    setActiveView('chat')
    void chat.createSession()
  }, [sidebar, chat])

  const handleSessionSelect = useCallback(
    (id: string): void => {
      sidebar.close()
      setActiveView('chat')
      void chat.activateSession(id)
    },
    [sidebar, chat],
  )

  const handleSessionBackdrop = useCallback((): void => sidebar.close(), [sidebar])
  const handleCancel = useCallback((): void => {
    void cancelPrompt()
  }, [cancelPrompt])

  return (
    <div className={`app${compact ? ' app--compact' : ''}`}>
      <Sidebar
        expanded={sidebar.expanded}
        compact={compact}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        disabled={state.generating}
        version={version}
        status={state.connection}
        toggleRef={sidebarToggleRef}
        settingsButtonRef={settingsButtonRef}
        onToggle={sidebar.toggle}
        onCreate={handleSessionCreate}
        onSelect={handleSessionSelect}
        onSettings={openSettings}
        onBackdrop={handleSessionBackdrop}
      />

      <main className="workspace">
        <div className="chat-view" hidden={activeView !== 'chat'}>
          <div className="notices">
            {state.notices.map((notice) => (
              <div key={notice.id} className="notice" role="status">
                <span>{notice.message}</span>
                <button
                  type="button"
                  className="notice-dismiss"
                  aria-label="Dismiss notice"
                  onClick={() => chat.dismissNotice(notice.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {state.error ? (
            <div className="error-banner" role="alert">
              <span>{state.error.message}</span>
              <button type="button" className="secondary-button" onClick={chat.dismissError}>
                Dismiss
              </button>
            </div>
          ) : null}

          <Transcript
            messages={chat.messages}
            generating={state.generating}
            sessionId={state.activeSessionId}
            onCopy={chat.copyText}
          />

          <Composer
            key={state.activeSessionId ?? 'empty'}
            disabled={state.activeSessionId === null}
            generating={state.generating}
            metadata={chat.latestMetadata}
            onSend={chat.sendPrompt}
            onStop={handleCancel}
          />
        </div>

        {activeView === 'settings' ? (
          <SettingsPage
            identityNodeId={state.identityNodeId}
            config={state.config}
            status={state.connection}
            onSaveConnect={chat.saveAndConnect}
            onCopy={chat.copyText}
            onBack={closeSettings}
          />
        ) : null}
      </main>
    </div>
  )
}

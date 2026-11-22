import { useEffect, useRef, useState } from 'react'
import brandBanner from './assets/hermes-iroh-banner.png'
import { Composer } from './components/Composer'
import { SessionList } from './components/SessionList'
import { SettingsPage } from './components/SettingsPage'
import { Transcript } from './components/Transcript'
import { isCancelKey } from './composer'
import { connectionLabel, formatWindowTitle } from './connection'
import { useChatController } from './useChatController'

type ActiveView = 'chat' | 'settings'

export default function App() {
  const chat = useChatController()
  const { state, cancelPrompt } = chat
  const [activeView, setActiveView] = useState<ActiveView>('chat')
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const returnFocusToSettingsRef = useRef(false)

  useEffect(() => {
    document.title = formatWindowTitle(state.connection.state)
  }, [state.connection.state])

  useEffect(() => {
    if (activeView === 'settings' || !returnFocusToSettingsRef.current) return
    returnFocusToSettingsRef.current = false
    settingsButtonRef.current?.focus()
  }, [activeView])

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

  const closeSettings = (): void => {
    returnFocusToSettingsRef.current = true
    setActiveView('chat')
  }

  const handleSessionCreate = (): void => {
    setActiveView('chat')
    void chat.createSession()
  }

  const handleSessionSelect = (id: string): void => {
    setActiveView('chat')
    void chat.activateSession(id)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <img className="brand-banner" src={brandBanner} alt="Hermes Iroh" />
        </header>

        <SessionList
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          disabled={state.generating}
          onCreate={handleSessionCreate}
          onSelect={handleSessionSelect}
        />

        <footer className="sidebar-footer">
          <div
            className="sidebar-status"
            role="status"
            aria-live="polite"
            title={state.connection.message}
          >
            <span
              className={`status-dot status-dot--${state.connection.state}`}
              aria-hidden="true"
            />
            <span>{connectionLabel(state.connection.state)}</span>
          </div>
          <button
            ref={settingsButtonRef}
            type="button"
            className="settings-action"
            onClick={() => setActiveView('settings')}
            aria-label="Settings"
            title="Settings"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path
                d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </footer>
      </aside>

      <main className="workspace">
        <div className="chat-view" hidden={activeView !== 'chat'}>
          <div className="notices">
            {state.notices.map((notice, index) => (
              <div key={`${notice.message}-${index}`} className="notice" role="status">
                <span>{notice.message}</span>
                <button
                  type="button"
                  className="notice-dismiss"
                  aria-label="Dismiss notice"
                  onClick={() => chat.dismissNotice(index)}
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
            key={state.activeSessionId ?? 'empty'}
            messages={chat.messages}
            generating={state.generating}
            onCopy={chat.copyText}
          />

          <Composer
            disabled={state.activeSessionId === null}
            generating={state.generating}
            metadata={chat.latestMetadata}
            onSend={chat.sendPrompt}
            onStop={() => void cancelPrompt()}
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

import { useEffect, useRef, useState } from 'react'
import { Composer } from './components/Composer'
import { SessionList } from './components/SessionList'
import { SettingsPage } from './components/SettingsPage'
import { Transcript } from './components/Transcript'
import { isCancelKey } from './composer'
import { formatWindowTitle } from './connection'
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
          <h1>Hermes Iroh App</h1>
        </header>

        <SessionList
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          disabled={state.generating}
          onCreate={handleSessionCreate}
          onSelect={handleSessionSelect}
        />

        <footer className="sidebar-footer">
          <button
            ref={settingsButtonRef}
            type="button"
            className="settings-action"
            onClick={() => setActiveView('settings')}
          >
            Settings
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

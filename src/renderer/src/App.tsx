import { useEffect, useRef, useState } from 'react'
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
  const returnFocusToSettingsRef = useRef(false)

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

  const openSettings = (): void => {
    sidebar.close()
    setActiveView('settings')
  }

  const handleSessionCreate = (): void => {
    sidebar.close()
    setActiveView('chat')
    void chat.createSession()
  }

  const handleSessionSelect = (id: string): void => {
    sidebar.close()
    setActiveView('chat')
    void chat.activateSession(id)
  }

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
        settingsButtonRef={settingsButtonRef}
        onToggle={sidebar.toggle}
        onCreate={handleSessionCreate}
        onSelect={handleSessionSelect}
        onSettings={openSettings}
        onBackdrop={sidebar.close}
      />

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

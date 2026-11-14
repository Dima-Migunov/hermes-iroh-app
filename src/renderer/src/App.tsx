import { Composer } from './components/Composer'
import { SessionList } from './components/SessionList'
import { SettingsPanel } from './components/SettingsPanel'
import { StatusIndicator } from './components/StatusIndicator'
import { Transcript } from './components/Transcript'
import { useChatController } from './useChatController'

export default function App() {
  const chat = useChatController()
  const { state } = chat

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>Iroh Channel</h1>
          <StatusIndicator status={state.connection} />
        </header>

        <SettingsPanel
          identityNodeId={state.identityNodeId}
          config={state.config}
          onSaveConnect={chat.saveAndConnect}
          onCopy={chat.copyText}
        />

        <SessionList
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          disabled={state.generating}
          onCreate={() => void chat.createSession()}
          onSelect={(id) => void chat.activateSession(id)}
        />
      </aside>

      <main className="workspace">
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
          disabled={state.generating || state.activeSessionId === null}
          onSend={chat.sendPrompt}
        />
      </main>
    </div>
  )
}

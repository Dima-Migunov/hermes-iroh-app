import type { SessionSummary } from '@shared/protocol'

interface SessionListProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  disabled: boolean
  onCreate: () => void
  onSelect: (id: string) => void
}

export function SessionList({
  sessions,
  activeSessionId,
  disabled,
  onCreate,
  onSelect,
}: SessionListProps) {
  return (
    <nav className="sessions" aria-label="Chat sessions">
      <div className="sessions-heading">
        <h2>Sessions</h2>
        <button type="button" className="secondary-button" onClick={onCreate} disabled={disabled}>
          New chat
        </button>
      </div>

      <ul className="session-list">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId
          return (
            <li key={session.id}>
              <button
                type="button"
                className={`session-button${isActive ? ' session-button--active' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onSelect(session.id)}
                disabled={disabled}
              >
                <span className="session-title">{session.title}</span>
                <time className="session-time" dateTime={session.updatedAt}>
                  {formatTimestamp(session.updatedAt)}
                </time>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

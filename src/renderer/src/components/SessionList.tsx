import { memo } from 'react'
import type { SessionSummary } from '@shared/protocol'

interface SessionListProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  disabled: boolean
  onCreate: () => void
  onSelect: (id: string) => void
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return DATE_FORMAT.format(date)
}

export const SessionList = memo(function SessionList({
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
        <button
          type="button"
          className="secondary-button new-chat-button"
          onClick={onCreate}
          disabled={disabled}
          aria-label="New chat"
          title="New chat"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M8 3v10M3 8h10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
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
})

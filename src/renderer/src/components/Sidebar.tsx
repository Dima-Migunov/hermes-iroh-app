import type { RefObject } from 'react'
import type { ConnectionStatus, SessionSummary } from '@shared/protocol'
import brandBanner from '../assets/hermes-iroh-banner.png'
import { connectionLabel } from '../connection'
import { SessionList } from './SessionList'

interface SidebarProps {
  expanded: boolean
  compact: boolean
  sessions: SessionSummary[]
  activeSessionId: string | null
  disabled: boolean
  version: string | null
  status: ConnectionStatus
  settingsButtonRef?: RefObject<HTMLButtonElement | null>
  onToggle: () => void
  onCreate: () => void
  onSelect: (id: string) => void
  onSettings: () => void
  onBackdrop: () => void
}

export function Sidebar({
  expanded,
  compact,
  sessions,
  activeSessionId,
  disabled,
  version,
  status,
  settingsButtonRef,
  onToggle,
  onCreate,
  onSelect,
  onSettings,
  onBackdrop,
}: SidebarProps) {
  const toggleLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar'

  return (
    <>
      {compact && expanded ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          title="Close sidebar"
          onClick={onBackdrop}
        />
      ) : null}

      <aside
        id="app-sidebar"
        className={`sidebar${expanded ? ' sidebar--expanded' : ' sidebar--rail'}${
          compact ? ' sidebar--compact' : ''
        }`}
      >
        <header className="brand">
          <div
            className="brand-banner-wrap"
            aria-hidden={expanded ? undefined : true}
          >
            <img className="brand-banner" src={brandBanner} alt="Hermes Iroh" />
            {version ? (
              <span className="brand-version" title={`Version ${version}`}>
                {version}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={onToggle}
            aria-label={toggleLabel}
            aria-expanded={expanded}
            aria-controls="app-sidebar"
            title={toggleLabel}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path
                d="M10 3 5 8l5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>

        <div
          className="sidebar-sessions"
          inert={!expanded}
          aria-hidden={expanded ? undefined : true}
        >
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            disabled={disabled}
            onCreate={onCreate}
            onSelect={onSelect}
          />
        </div>

        <footer className="sidebar-footer">
          <div
            className="sidebar-status"
            role="status"
            aria-live="polite"
            title={status.message ?? connectionLabel(status.state)}
          >
            <span
              className={`status-dot status-dot--${status.state}`}
              aria-hidden="true"
            />
            <span className="sidebar-status-label">{connectionLabel(status.state)}</span>
          </div>
          <button
            ref={settingsButtonRef}
            type="button"
            className="settings-action"
            onClick={onSettings}
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
    </>
  )
}

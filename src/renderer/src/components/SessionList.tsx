import { memo, useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import type { SessionDeletionResult, SessionSummary } from '@shared/protocol'

interface SessionListProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  disabled: boolean
  onCreate: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => Promise<boolean>
  onDelete: (id: string) => Promise<SessionDeletionResult | null>
}

type RowMode = 'actions' | 'rename' | 'confirm'

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return DATE_FORMAT.format(date)
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="m3 11.5-.5 2 2-.5 7.4-7.4-1.5-1.5zM10.7 3.3l1.5 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8h6l.5-8M6.5 7v3M9.5 7v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="m3.5 8.5 3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="m4 4 8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

export const SessionList = memo(function SessionList({
  sessions,
  activeSessionId,
  disabled,
  onCreate,
  onSelect,
  onRename,
  onDelete,
}: SessionListProps) {
  const [openRowId, setOpenRowId] = useState<string | null>(null)
  const [mode, setMode] = useState<RowMode>('actions')
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null)
  const [focusTriggerId, setFocusTriggerId] = useState<string | null>(null)

  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const renameInputRef = useRef<HTMLInputElement>(null)
  const confirmCancelRef = useRef<HTMLButtonElement>(null)

  const openActions = (id: string): void => {
    setOpenRowId(id)
    setMode('actions')
    setRenameDraft('')
    setRenameError(null)
  }

  const closeActions = (): void => {
    setOpenRowId(null)
    setMode('actions')
    setRenameDraft('')
    setRenameError(null)
  }

  const focusTrigger = (id: string): void => {
    setFocusTriggerId(id)
  }

  useEffect(() => {
    if (!disabled) return
    closeActions()
    setPending(false)
  }, [disabled])

  useEffect(() => {
    if (!openRowId) return
    if (sessions.some((session) => session.id === openRowId)) return
    closeActions()
    setPending(false)
  }, [openRowId, sessions])

  useEffect(() => {
    if (!pendingFocusId) return
    const button = buttonRefs.current.get(pendingFocusId)
    if (!button) return
    button.focus()
    setPendingFocusId(null)
  }, [pendingFocusId, sessions, activeSessionId])

  useEffect(() => {
    if (!focusTriggerId || mode !== 'actions') return
    const trigger = triggerRefs.current.get(focusTriggerId)
    if (!trigger) return
    trigger.focus()
    setFocusTriggerId(null)
  }, [focusTriggerId, mode, sessions])

  useEffect(() => {
    if (mode === 'rename') {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    } else if (mode === 'confirm') {
      confirmCancelRef.current?.focus()
    }
  }, [mode, openRowId])

  useEffect(() => {
    if (openRowId === null || mode !== 'actions') return

    const handlePointerDown = (event: globalThis.PointerEvent): void => {
      const row = rowRefs.current.get(openRowId)
      if (row && event.target instanceof Node && row.contains(event.target)) return
      closeActions()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [openRowId, mode])

  const handlePointerLeave = (
    event: PointerEvent<HTMLDivElement>,
    sessionId: string,
  ): void => {
    if (event.pointerType === 'touch' || mode !== 'actions' || openRowId !== sessionId) return
    const row = rowRefs.current.get(sessionId)
    if (row?.contains(document.activeElement)) return
    closeActions()
  }

  const startRename = (session: SessionSummary): void => {
    if (disabled) return
    setMode('rename')
    setRenameDraft(session.title)
    setRenameError(null)
  }

  const cancelRename = (sessionId: string): void => {
    if (pending) return
    setMode('actions')
    setRenameError(null)
    focusTrigger(sessionId)
  }

  const submitRename = async (
    event: FormEvent<HTMLFormElement>,
    sessionId: string,
  ): Promise<void> => {
    event.preventDefault()
    if (disabled || pending) return

    const title = renameDraft.trim()
    if (title.length === 0) {
      setRenameError('A title is required.')
      return
    }
    if ([...title].length > 60) {
      setRenameError('Titles are limited to 60 characters.')
      return
    }

    setPending(true)
    const succeeded = await onRename(sessionId, title)
    setPending(false)

    if (succeeded) {
      closeActions()
    } else {
      setMode('actions')
      setRenameError(null)
    }
    focusTrigger(sessionId)
  }

  const startDelete = (): void => {
    if (disabled) return
    setMode('confirm')
  }

  const cancelDelete = (sessionId: string): void => {
    if (pending) return
    setMode('actions')
    focusTrigger(sessionId)
  }

  const confirmDelete = async (sessionId: string): Promise<void> => {
    if (disabled || pending) return
    setPending(true)
    const result = await onDelete(sessionId)
    setPending(false)

    if (result) {
      closeActions()
      setPendingFocusId(result.activeSession.session.id)
    } else {
      setMode('actions')
      focusTrigger(sessionId)
    }
  }

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
          const isOpen = openRowId === session.id && mode === 'actions'
          const isRenaming = openRowId === session.id && mode === 'rename'
          const isConfirming = openRowId === session.id && mode === 'confirm'

          return (
            <li
              key={session.id}
              className={`session-row${isActive ? ' session-row--active' : ''}`}
              ref={(node) => {
                if (node) rowRefs.current.set(session.id, node)
                else rowRefs.current.delete(session.id)
              }}
            >
              {isRenaming ? (
                <form
                  className="session-rename"
                  onSubmit={(event) => void submitRename(event, session.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelRename(session.id)
                    }
                  }}
                >
                  <input
                    ref={renameInputRef}
                    className="session-rename-input"
                    type="text"
                    value={renameDraft}
                    maxLength={60}
                    disabled={pending}
                    aria-label="Session title"
                    aria-invalid={renameError ? true : undefined}
                    aria-describedby={
                      renameError ? `rename-error-${session.id}` : undefined
                    }
                    onChange={(event) => {
                      setRenameDraft(event.target.value)
                      if (renameError) setRenameError(null)
                    }}
                  />
                  <div className="session-rename-controls">
                    <button
                      type="submit"
                      className="session-icon-button"
                      disabled={pending}
                      aria-label="Save title"
                      title="Save title"
                    >
                      <CheckIcon />
                    </button>
                    <button
                      type="button"
                      className="session-icon-button"
                      disabled={pending}
                      onClick={() => cancelRename(session.id)}
                      aria-label="Cancel rename"
                      title="Cancel rename"
                    >
                      <CloseIcon />
                    </button>
                  </div>
                  {renameError ? (
                    <span
                      id={`rename-error-${session.id}`}
                      className="session-rename-error"
                      role="alert"
                    >
                      {renameError}
                    </span>
                  ) : null}
                </form>
              ) : isConfirming ? (
                <div
                  className="session-delete-confirm"
                  role="group"
                  aria-label="Delete session"
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    cancelDelete(session.id)
                  }}
                >
                  <span className="session-delete-question">Delete this session?</span>
                  <div className="session-delete-controls">
                    <button
                      ref={confirmCancelRef}
                      type="button"
                      className="secondary-button session-delete-cancel"
                      disabled={pending}
                      onClick={() => cancelDelete(session.id)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="danger-button session-delete-confirm-button"
                      disabled={pending}
                      onClick={() => void confirmDelete(session.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className={`session-button${isActive ? ' session-button--active' : ''}`}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => {
                      closeActions()
                      onSelect(session.id)
                    }}
                    disabled={disabled}
                    ref={(node) => {
                      if (node) buttonRefs.current.set(session.id, node)
                      else buttonRefs.current.delete(session.id)
                    }}
                  >
                    <span className="session-title">{session.title}</span>
                    <time className="session-time" dateTime={session.updatedAt}>
                      {formatTimestamp(session.updatedAt)}
                    </time>
                  </button>

                  <div
                    className={`session-actions${isOpen ? ' session-actions--open' : ''}`}
                    onPointerEnter={(event) => {
                      if (event.pointerType === 'touch' || disabled) return
                      if (!isOpen) openActions(session.id)
                    }}
                    onPointerLeave={(event) => handlePointerLeave(event, session.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape' || !isOpen) return
                      event.preventDefault()
                      event.stopPropagation()
                      closeActions()
                      focusTrigger(session.id)
                    }}
                  >
                    <button
                      ref={(node) => {
                        if (node) triggerRefs.current.set(session.id, node)
                        else triggerRefs.current.delete(session.id)
                      }}
                      type="button"
                      className="session-actions-trigger"
                      aria-label="Session actions"
                      aria-expanded={isOpen}
                      title="Session actions"
                      disabled={disabled}
                      onFocus={() => {
                        if (!disabled) openActions(session.id)
                      }}
                      onClick={() => {
                        if (disabled) return
                        if (isOpen) closeActions()
                        else openActions(session.id)
                      }}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="16"
                        height="16"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
                        <circle cx="8" cy="8" r="1.25" fill="currentColor" />
                        <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
                      </svg>
                    </button>

                    <div
                      className="session-actions-menu"
                      inert={!isOpen}
                      aria-hidden={!isOpen}
                    >
                      <button
                        type="button"
                        className="session-icon-button"
                        aria-label="Rename session"
                        title="Rename session"
                        disabled={disabled || pending}
                        onClick={() => startRename(session)}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="session-icon-button session-icon-button--danger"
                        aria-label="Delete session"
                        title="Delete session"
                        disabled={disabled || pending}
                        onClick={startDelete}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
})

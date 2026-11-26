import { useState } from 'react'
import type { ResponseMetadata } from '@shared/protocol'
import { composerAction, isSubmittable } from '../composer'
import { ComposerMetadata } from './ComposerMetadata'

interface ComposerProps {
  disabled: boolean
  generating: boolean
  metadata?: ResponseMetadata
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
}

export function Composer({ disabled, generating, metadata, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (): Promise<void> => {
    if (disabled || generating || submitting || !isSubmittable(text)) return
    const value = text
    setSubmitting(true)
    setText('')

    let started = false
    try {
      started = await onSend(value)
    } catch {
      started = false
    } finally {
      setSubmitting(false)
    }

    if (!started) {
      setText((current) => (current.length > 0 ? current : value))
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label className="visually-hidden" htmlFor="composer-input">
        Message
      </label>
      <div className="composer-field">
        <textarea
          id="composer-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            const action = composerAction({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            })
            if (action === 'send') {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={disabled ? 'Waiting for a session…' : 'Ask the agent…'}
          rows={3}
          disabled={disabled}
        />
        <button
          type={generating ? 'button' : 'submit'}
          className={
            generating
              ? 'primary-button composer-send-button stop-button'
              : 'primary-button composer-send-button'
          }
          onClick={generating ? onStop : undefined}
          onMouseDown={(event) => event.preventDefault()}
          aria-label={generating ? 'Stop' : 'Send'}
          title={generating ? 'Stop' : 'Send'}
        >
          {generating ? (
            <svg
              className="composer-stop-icon"
              viewBox="0 0 14 14"
              width="14"
              height="14"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="1" y="1" width="12" height="12" rx="1.5" fill="currentColor" />
            </svg>
          ) : (
            '↑'
          )}
        </button>
      </div>
      <div className="composer-actions">
        <span className="composer-hint">
          {generating
            ? 'Escape to stop the response'
            : 'Enter to send · Shift+Enter for a new line'}
        </span>
        <ComposerMetadata metadata={metadata} />
      </div>
    </form>
  )
}

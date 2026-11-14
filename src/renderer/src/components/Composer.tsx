import { useState } from 'react'
import { composerAction, isSubmittable } from '../composer'

interface ComposerProps {
  disabled: boolean
  onSend: (text: string) => Promise<boolean>
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [text, setText] = useState('')

  const submit = (): void => {
    if (disabled || !isSubmittable(text)) return
    const value = text
    setText('')
    void onSend(value)
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label className="visually-hidden" htmlFor="composer-input">
        Message
      </label>
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
            submit()
          }
        }}
        placeholder={disabled ? 'Waiting for the current response…' : 'Ask the agent…'}
        rows={3}
        disabled={disabled}
      />
      <div className="composer-actions">
        <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
        <button type="submit" className="primary-button" disabled={disabled || !isSubmittable(text)}>
          Send
        </button>
      </div>
    </form>
  )
}

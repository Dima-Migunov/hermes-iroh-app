import { useLayoutEffect, useRef } from 'react'
import type { StoredMessage } from '@shared/protocol'
import { MessageItem } from './MessageItem'

interface TranscriptProps {
  messages: StoredMessage[]
  generating: boolean
  onCopy: (text: string) => Promise<void>
}

export function Transcript({ messages, generating, onCopy }: TranscriptProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current
      if (container && pinnedRef.current) {
        container.scrollTop = container.scrollHeight
      }
    })

    return () => cancelAnimationFrame(frame)
  }, [messages])

  const handleScroll = (): void => {
    const container = containerRef.current
    if (!container) return
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    pinnedRef.current = distance < 48
  }

  return (
    <div
      className="transcript"
      ref={containerRef}
      onScroll={handleScroll}
      role="log"
      aria-label="Conversation transcript"
      aria-live="polite"
      aria-busy={generating}
    >
      {messages.length === 0 ? (
        <div className="empty-state">
          <h2>No messages yet</h2>
          <p>Connect to the server, then start the conversation below.</p>
        </div>
      ) : (
        <ol className="message-list">
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} onCopy={onCopy} />
          ))}
        </ol>
      )}
    </div>
  )
}

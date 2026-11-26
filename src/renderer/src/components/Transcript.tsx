import type { WheelEvent } from 'react'
import type { StoredMessage } from '@shared/protocol'
import { useTranscriptScroll } from '../useTranscriptScroll'
import { useUserMessageRail } from '../useUserMessageRail'
import { MessageItem } from './MessageItem'
import { UserMessageRail } from './UserMessageRail'

interface TranscriptProps {
  messages: StoredMessage[]
  generating: boolean
  sessionId: string | null
  onCopy: (text: string) => Promise<void>
}

export function Transcript({ messages, generating, sessionId, onCopy }: TranscriptProps) {
  const {
    containerRef,
    contentRef,
    onScroll,
    newMessageCount,
    hasUnseenActivity,
    returnToLatest,
    jumpToMessage,
  } = useTranscriptScroll(messages, sessionId)
  const { markers, railRight, railHeight } = useUserMessageRail(
    messages,
    sessionId,
    containerRef,
    contentRef,
  )

  const showNewMessages = newMessageCount > 0 || hasUnseenActivity
  const label =
    newMessageCount > 0 ? `New messages, ${newMessageCount} new` : 'New messages'

  const handleReturnToLatest = (): void => {
    returnToLatest()
    containerRef.current?.focus({ preventScroll: true })
  }

  const handleNavWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const container = containerRef.current
    if (!container) return
    if (typeof container.scrollBy === 'function') {
      container.scrollBy({ top: event.deltaY })
    } else {
      container.scrollTop += event.deltaY
    }
  }

  return (
    <div className="transcript-shell">
      <div
        className={showNewMessages ? 'transcript transcript--has-new' : 'transcript'}
        ref={containerRef}
        onScroll={onScroll}
        role="log"
        tabIndex={0}
        aria-label="Conversation transcript"
        aria-live="polite"
        aria-busy={generating}
      >
        <div className="transcript-content" ref={contentRef}>
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
      </div>

      {markers.length > 0 ? (
        <UserMessageRail
          markers={markers}
          railRight={railRight}
          railHeight={railHeight}
          onJump={jumpToMessage}
        />
      ) : null}

      {showNewMessages ? (
        <div className="transcript-nav" onWheel={handleNavWheel}>
          <button
            type="button"
            className="new-messages-button"
            aria-label={label}
            onClick={handleReturnToLatest}
          >
            <span>New messages</span>
            {newMessageCount > 0 ? (
              <span className="new-messages-count" aria-hidden="true">
                {newMessageCount}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}
    </div>
  )
}

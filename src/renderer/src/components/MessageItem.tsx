import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { StoredMessage } from '@shared/protocol'
import { CopyButton } from './CopyButton'

interface MessageItemProps {
  message: StoredMessage
  onCopy: (text: string) => Promise<void>
}

export function MessageItem({ message, onCopy }: MessageItemProps) {
  const isUser = message.role === 'user'

  return (
    <li className={`message message--${message.role}`}>
      <header className="message-header">
        <span className="message-author">{isUser ? 'You' : 'Assistant'}</span>
        <time className="message-time" dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
        {!isUser && message.status === 'complete' && message.content.length > 0 ? (
          <CopyButton text={message.content} label="Copy answer" onCopy={onCopy} />
        ) : null}
      </header>

      {!isUser && message.content.length === 0 && message.status === 'streaming' ? (
        <p className="thinking">Assistant is responding…</p>
      ) : (
        <div className="markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[rehypeSanitize, rehypeHighlight]}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      )}

      {message.status === 'streaming' ? (
        <span className="streaming-caret" aria-hidden="true" />
      ) : null}

      {message.status === 'failed' ? (
        <p className="message-status message-status--error" role="alert">
          Failed: {message.error?.message ?? 'The request failed.'}
        </p>
      ) : null}

      {message.status === 'interrupted' ? (
        <p className="message-status">Response interrupted before completion.</p>
      ) : null}
    </li>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import ReactMarkdown, { type Options as MarkdownOptions } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { StoredMessage, ToolCall } from '@shared/protocol'
import {
  TOOLTIP_MARGIN_PX,
  TOOLTIP_MAX_WIDTH_PX,
  placeTooltip,
  type TooltipPlacement,
} from '../transcriptGeometry'
import {
  TRUNCATED_ARGUMENTS_NOTE,
  buildMessageSegments,
  describeToolCall,
  formatToolArguments,
} from '../toolCalls'
import { CopyButton } from './CopyButton'

interface MessageItemProps {
  message: StoredMessage
  onCopy: (text: string) => Promise<void>
}

const REMARK_PLUGINS: MarkdownOptions['remarkPlugins'] = [remarkGfm, remarkBreaks]
const REHYPE_PLUGINS: MarkdownOptions['rehypePlugins'] = [rehypeSanitize, rehypeHighlight]

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
})

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return TIME_FORMAT.format(date)
}

function fallbackViewport(): {
  top: number
  bottom: number
  left: number
  right: number
} {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth
  const height = typeof window === 'undefined' ? 0 : window.innerHeight
  return { top: 0, bottom: height, left: 0, right: width }
}

interface ToolProgressLineProps {
  call: ToolCall
  text: string
  open: boolean
  onOpen: () => void
  onClose: () => void
}

function ToolProgressLine({ call, text, open, onOpen, onClose }: ToolProgressLineProps) {
  const rowRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const descriptionId = useId()
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const row = rowRef.current
    const tooltip = tooltipRef.current
    if (!row || !tooltip) return

    const shell = row.closest('.transcript-shell')
    const viewport = shell?.getBoundingClientRect() ?? fallbackViewport()
    const availableWidth = Math.max(
      0,
      viewport.right - viewport.left - TOOLTIP_MARGIN_PX * 2,
    )
    // Constrain the width before measuring so wrapped height, not the
    // unwrapped single-line height, decides which side the card fits on.
    tooltip.style.maxWidth = `${Math.min(TOOLTIP_MAX_WIDTH_PX, availableWidth)}px`
    setPlacement(
      placeTooltip(row.getBoundingClientRect(), viewport, {
        width: tooltip.offsetWidth,
        height: tooltip.offsetHeight,
      }),
    )
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const handleScroll = (event: Event): void => {
      const tooltip = tooltipRef.current
      const target = event.target
      if (tooltip && target instanceof Node && tooltip.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [open, onClose])

  const handlePointerEnter = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch') return
    onOpen()
  }

  const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch') return
    onClose()
  }

  return (
    <div
      className="tool-progress"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <button
        ref={rowRef}
        type="button"
        className={open ? 'tool-progress__row tool-progress__row--active' : 'tool-progress__row'}
        aria-describedby={descriptionId}
        onFocus={onOpen}
        onBlur={onClose}
        onClick={onOpen}
      >
        {text}
      </button>
      <span id={descriptionId} className="visually-hidden">
        {describeToolCall(call)}
      </span>
      {open ? (
        <div
          ref={tooltipRef}
          className="tool-progress__tooltip"
          role="tooltip"
          aria-hidden="true"
          data-placement={placement?.above ? 'above' : 'below'}
          style={{
            top: placement ? `${placement.top}px` : undefined,
            left: placement ? `${placement.left}px` : undefined,
            maxWidth: placement ? `${placement.maxWidth}px` : undefined,
            maxHeight: placement ? `${placement.maxHeight}px` : undefined,
            visibility: placement ? 'visible' : 'hidden',
          }}
        >
          <span className="tool-progress__tooltip-name">{call.name}</span>
          <div className="tool-progress__tooltip-arguments">
            {formatToolArguments(call.arguments)}
          </div>
          {call.truncated ? (
            <p className="tool-progress__tooltip-truncated">{TRUNCATED_ARGUMENTS_NOTE}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const MessageItem = memo(function MessageItem({ message, onCopy }: MessageItemProps) {
  const isUser = message.role === 'user'
  const segments = useMemo(
    () => (isUser ? [] : buildMessageSegments(message.content, message.toolCalls)),
    [isUser, message.content, message.toolCalls],
  )
  const [activeLine, setActiveLine] = useState<number | null>(null)
  const hasTools = segments.length > 0

  return (
    <li className={`message message--${message.role}`} data-message-id={message.id}>
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
      ) : hasTools ? (
        <div className="message-body message-body--tools">
          {segments.map((segment, index) =>
            segment.kind === 'markdown' ? (
              <div className="markdown" key={`markdown-${index}`}>
                <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                  {segment.content}
                </ReactMarkdown>
              </div>
            ) : (
              <ToolProgressLine
                key={`tool-${segment.lineIndex}-${segment.call.id ?? index}`}
                call={segment.call}
                text={segment.text}
                open={activeLine === segment.lineIndex}
                onOpen={() => setActiveLine(segment.lineIndex)}
                onClose={() =>
                  setActiveLine((current) => (current === segment.lineIndex ? null : current))
                }
              />
            ),
          )}
        </div>
      ) : (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
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
})

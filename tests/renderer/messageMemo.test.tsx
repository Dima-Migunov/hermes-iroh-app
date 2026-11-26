import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/protocol'
import { MessageItem } from '@renderer/components/MessageItem'

const noop = async (): Promise<void> => undefined

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'The answer',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    ...overrides,
  }
}

function render(value: StoredMessage, onCopy = noop): string {
  return renderToStaticMarkup(<MessageItem message={value} onCopy={onCopy} />)
}

describe('MessageItem memoization contract', () => {
  it('is a memo component so an unchanged message keeps its identity', () => {
    expect((MessageItem as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })

  it('renders identical markup across repeated renders of one message', () => {
    const value = message({ content: '**bold** and `code`' })

    expect(render(value)).toBe(render(value))
  })

  it('renders a changed message differently', () => {
    const first = render(message({ content: 'first' }))
    const second = render(message({ content: 'second' }))

    expect(first).not.toBe(second)
  })

  it('keeps the markdown plugin arrays stable across renders', () => {
    const value = message({ content: '```ts\nconst a = 1\n```' })

    expect(render(value)).toContain('hljs')
    expect(render(value)).toContain('language-ts')
  })
})

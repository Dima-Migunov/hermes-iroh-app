import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/protocol'
import { MessageItem } from '@renderer/components/MessageItem'

const noop = async (): Promise<void> => undefined

function render(
  content: string,
  overrides: Partial<StoredMessage> = {},
): string {
  const message: StoredMessage = {
    id: 'message-1',
    role: 'assistant',
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    ...overrides,
  }
  return renderToStaticMarkup(<MessageItem message={message} onCopy={noop} />)
}

describe('MessageItem markdown rendering', () => {
  it('renders fenced code with syntax highlighting classes', () => {
    const html = render('```ts\nconst value: number = 1\n```')
    const text = html.replace(/<[^>]+>/g, '')

    expect(html).toContain('<pre>')
    expect(html).toContain('<code')
    expect(html).toMatch(/hljs/)
    expect(html).toContain('language-ts')
    expect(text).toContain('const value: number = 1')
  })

  it.each(['assistant', 'user'] as const)(
    'does not emit executable markup for embedded HTML in %s messages',
    (role) => {
      const html = render(
        'before\n\n<script>window.__pwned = true</script>\n\n[link](javascript:alert(1))\n\nafter',
        { role },
      )

      expect(html).not.toContain('<script')
      expect(html.toLowerCase()).not.toContain('javascript:')
      expect(html).toContain('before')
      expect(html).toContain('after')
    },
  )

  it('renders Markdown in user messages', () => {
    const html = render('**bold** and `code`', { role: 'user' })

    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).not.toContain('**bold**')
  })

  it.each(['user', 'assistant'] as const)(
    'preserves single line breaks in %s messages',
    (role) => {
      const html = render('first line\nsecond line', { role })

      expect(html).toMatch(/first line<br\/?>\s*second line/)
    },
  )

  it('offers answer copying only for completed assistant messages', () => {
    expect(render('done')).toContain('Copy answer')
    expect(render('partial', { status: 'streaming' })).not.toContain('Copy answer')
    expect(render('failed', { status: 'failed' })).not.toContain('Copy answer')
  })
})

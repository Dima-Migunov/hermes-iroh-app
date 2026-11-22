import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ResponseMetadata, StoredMessage } from '@shared/protocol'
import { Composer } from '@renderer/components/Composer'
import { ComposerMetadata } from '@renderer/components/ComposerMetadata'
import { MessageItem } from '@renderer/components/MessageItem'
import {
  initialChatState,
  selectLatestResponseMetadata,
  type ChatState,
} from '@renderer/state/chatReducer'

const noop = async (): Promise<void> => undefined
const send = async (): Promise<boolean> => true
const stop = (): void => undefined

const fullMetadata: ResponseMetadata = {
  schema: 1,
  generated_at: '2026-11-21T12:00:00.000Z',
  latency_ms: 812,
  model: 'Qwen/Qwen3.7-Flash',
  provider: 'commandcode',
  usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
  session_usage: {
    input_tokens: 10200,
    output_tokens: 2400,
    total_tokens: 12600,
    api_calls: 8,
    estimated_cost_usd: 0,
    cost_status: 'estimated',
    cost_source: 'model_catalog',
    context_tokens: 217400,
    context_length: 1000000,
    context_percent: 22,
  },
  balance: {
    provider: 'nous',
    remaining_usd: 12.5,
    paid_access: true,
    as_of_ms: 1763726400000,
  },
}

function metadata(overrides: Partial<ResponseMetadata> = {}): ResponseMetadata {
  return {
    schema: 1,
    generated_at: '2026-11-21T12:00:00.000Z',
    latency_ms: 812,
    ...overrides,
  }
}

function renderMetadata(value?: ResponseMetadata): string {
  return renderToStaticMarkup(<ComposerMetadata metadata={value} />)
}

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

function stateWith(
  activeSessionId: string | null,
  transcripts: Record<string, StoredMessage[]>,
): ChatState {
  return { ...initialChatState, activeSessionId, transcripts }
}

function textContent(html: string): string {
  return decodeHtml(html.replace(/<!--.*?-->/g, '').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

describe('ComposerMetadata', () => {
  it('shows only the model, compact context, and cost with single spaces', () => {
    expect(textContent(renderMetadata(fullMetadata))).toBe(
      'Qwen/Qwen3.7-Flash 217.4K / 1M (22%) $0.00',
    )
  })

  it('uses compact token counts and keeps a fractional percentage', () => {
    const text = textContent(
      renderMetadata(
        metadata({
          session_usage: {
            context_tokens: 8400,
            context_length: 128000,
            context_percent: 6.6,
            estimated_cost_usd: 0.42,
          },
        }),
      ),
    )

    expect(text).toBe('8.4K / 128K (6.6%) $0.42')
  })

  it('shows the cost even when it is zero', () => {
    const text = textContent(
      renderMetadata(metadata({ session_usage: { estimated_cost_usd: 0 } })),
    )

    expect(text).toBe('$0.00')
  })

  it('omits absent values without labels or placeholders', () => {
    expect(textContent(renderMetadata(metadata({ model: 'gpt-5.1' })))).toBe('gpt-5.1')

    const html = renderMetadata(metadata({ latency_ms: 10 }))
    expect(html).toBe('')
  })

  it('omits the percentage and length when they are absent', () => {
    expect(
      textContent(
        renderMetadata(metadata({ session_usage: { context_tokens: 8400, context_length: 128000 } })),
      ),
    ).toBe('8.4K / 128K')

    expect(
      textContent(renderMetadata(metadata({ session_usage: { context_percent: 4.2 } }))),
    ).toBe('4.2%')
  })

  it('does not show the provider, latency, turn usage, or balance', () => {
    const text = textContent(renderMetadata(fullMetadata))

    expect(text).not.toContain('commandcode')
    expect(text).not.toContain('812')
    expect(text).not.toContain('Session')
    expect(text).not.toContain('Balance')
    expect(text).not.toContain('Input')
    expect(text).not.toContain('Output')
    expect(text).not.toContain('$12.50')
  })

  it('renders metadata strings as text instead of markup', () => {
    const html = renderMetadata(
      metadata({
        model: '<img src=x onerror="alert(1)">',
        session_usage: { estimated_cost_usd: 0.42 },
      }),
    )

    expect(html).not.toContain('<img')
    expect(textContent(html)).toContain('<img src=x onerror="alert(1)">')
  })
})

describe('selectLatestResponseMetadata', () => {
  it('uses the latest completed assistant response with metadata', () => {
    const older = metadata({ model: 'older-model' })
    const latest = metadata({ model: 'latest-model' })
    const state = stateWith('session-1', {
      'session-1': [
        message({ id: 'assistant-1', metadata: older }),
        message({ id: 'user-1', role: 'user', content: 'Next question' }),
        message({ id: 'assistant-2', metadata: latest }),
        message({ id: 'assistant-3', status: 'streaming', metadata: metadata({ model: 'streaming' }) }),
      ],
    })

    expect(selectLatestResponseMetadata(state)).toBe(latest)
  })

  it('skips completed messages without metadata', () => {
    const older = metadata({ model: 'older-model' })
    const state = stateWith('session-1', {
      'session-1': [
        message({ id: 'assistant-1', metadata: older }),
        message({ id: 'assistant-2' }),
        message({ id: 'assistant-3', status: 'interrupted', metadata: metadata({ model: 'stopped' }) }),
      ],
    })

    expect(selectLatestResponseMetadata(state)).toBe(older)
  })

  it('follows the active session', () => {
    const state = stateWith('session-1', {
      'session-1': [message({ id: 'assistant-1', metadata: metadata({ model: 'first' }) })],
      'session-2': [message({ id: 'assistant-2', metadata: metadata({ model: 'second' }) })],
    })

    expect(selectLatestResponseMetadata(state)?.model).toBe('first')
    expect(selectLatestResponseMetadata({ ...state, activeSessionId: 'session-2' })?.model).toBe(
      'second',
    )
  })

  it('returns nothing without an active session or metadata', () => {
    const state = stateWith('session-1', { 'session-1': [message()] })

    expect(selectLatestResponseMetadata(state)).toBeUndefined()
    expect(selectLatestResponseMetadata({ ...state, activeSessionId: null })).toBeUndefined()
  })
})

describe('Composer metadata placement', () => {
  it('renders the status after the hint below the message field', () => {
    const html = renderToStaticMarkup(
      <Composer disabled={false} generating={false} metadata={fullMetadata} onSend={send} onStop={stop} />,
    )

    const field = html.indexOf('composer-field')
    const actions = html.indexOf('composer-actions')
    const hint = html.indexOf('composer-hint')
    const status = html.indexOf('composer-metadata')

    expect(field).toBeGreaterThan(-1)
    expect(actions).toBeGreaterThan(field)
    expect(hint).toBeGreaterThan(actions)
    expect(status).toBeGreaterThan(hint)
    expect(textContent(html)).toContain('Qwen/Qwen3.7-Flash 217.4K / 1M (22%) $0.00')
  })

  it('renders no status without metadata', () => {
    const html = renderToStaticMarkup(
      <Composer disabled={false} generating={false} onSend={send} onStop={stop} />,
    )

    expect(html).not.toContain('composer-metadata')
  })
})

describe('Message metadata', () => {
  it('is not rendered inside a completed assistant message', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ metadata: fullMetadata })} onCopy={noop} />,
    )
    const text = textContent(html)

    expect(html).not.toContain('message-metadata')
    expect(text).not.toContain('Qwen/Qwen3.7-Flash')
    expect(text).not.toContain('217.4K')
    expect(text).not.toContain('$0.00')
  })
})

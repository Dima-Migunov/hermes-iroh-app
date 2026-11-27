import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredMessage, ToolCall } from '@shared/protocol'
import { MessageItem } from '@renderer/components/MessageItem'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const noop = async (): Promise<void> => undefined

let root: Root | null = null
let container: HTMLDivElement | null = null

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    name: 'search',
    arguments: { query: 'find the docs' },
    truncated: false,
    lineIndex: 1,
    ...overrides,
  }
}

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'first line\nsearching the docs\nlast line',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    toolCalls: [call()],
    ...overrides,
  }
}

function render(value: StoredMessage): void {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  act(() => {
    root?.render(
      <div className="transcript-shell">
        <ol className="message-list">
          <MessageItem key={value.id} message={value} onCopy={noop} />
        </ol>
      </div>,
    )
  })
}

function rows(): HTMLButtonElement[] {
  return [...container!.querySelectorAll<HTMLButtonElement>('.tool-progress__row')]
}

function row(index = 0): HTMLButtonElement {
  const value = rows()[index]
  if (!value) throw new Error(`missing tool row ${index}`)
  return value
}

function tooltip(): HTMLElement | null {
  return container!.querySelector<HTMLElement>('.tool-progress__tooltip')
}

function pointerOver(target: Element, pointerType = 'mouse'): void {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }))
  })
}

function pointerOut(target: Element, pointerType = 'mouse'): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent('pointerout', {
        bubbles: true,
        pointerType,
        relatedTarget: document.body,
      }),
    )
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

describe('MessageItem tool progress rows', () => {
  it('renders mixed content as Markdown groups around the exact progress line', () => {
    render(message())

    expect(rows()).toHaveLength(1)
    expect(row().textContent).toBe('searching the docs')
    expect(container!.querySelectorAll('.markdown')).toHaveLength(2)
    expect(container!.textContent).toContain('first line')
    expect(container!.textContent).toContain('last line')
    expect(tooltip()).toBeNull()
  })

  it('keeps the ordinary Markdown path when no call is usable', () => {
    render(message({ toolCalls: [call({ lineIndex: 8 })] }))

    expect(rows()).toHaveLength(0)
    expect(container!.querySelectorAll('.markdown')).toHaveLength(1)
    expect(container!.textContent).toContain('searching the docs')
  })

  it('keeps the ordinary Markdown path for history without tool calls', () => {
    render(message({ toolCalls: undefined }))

    expect(rows()).toHaveLength(0)
    expect(container!.querySelectorAll('.markdown')).toHaveLength(1)
  })

  it('shows a row only after the line it points at arrives', () => {
    render(message({ content: '', toolCalls: [call({ lineIndex: 0 })] }))
    expect(rows()).toHaveLength(0)

    render(message({ content: 'searching now\n', toolCalls: [call({ lineIndex: 0 })] }))
    expect(rows()).toHaveLength(1)
    expect(row().textContent).toBe('searching now')
  })

  it('does not treat tool calls on user messages as progress rows', () => {
    render(message({ role: 'user' }))

    expect(rows()).toHaveLength(0)
  })
})

describe('MessageItem tool tooltip interaction', () => {
  it('shows the tool name and complete arguments on hover and hides on leave', () => {
    render(message())

    pointerOver(row())
    expect(tooltip()).not.toBeNull()
    expect(tooltip()?.textContent).toContain('search')
    expect(tooltip()?.textContent).toContain('find the docs')
    expect(tooltip()?.getAttribute('aria-hidden')).toBe('true')

    pointerOut(row())
    expect(tooltip()).toBeNull()
  })

  it('opens on keyboard focus and closes on blur', () => {
    render(message())

    act(() => {
      row().focus()
    })
    expect(tooltip()).not.toBeNull()

    act(() => {
      row().blur()
    })
    expect(tooltip()).toBeNull()
  })

  it('opens on touch activation without hover', () => {
    render(message())

    pointerOver(row(), 'touch')
    expect(tooltip()).toBeNull()

    act(() => {
      row().click()
    })
    expect(tooltip()).not.toBeNull()
  })

  it('dismisses on Escape and on transcript scroll', () => {
    render(message())

    act(() => {
      row().focus()
    })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(tooltip()).toBeNull()

    act(() => {
      row().focus()
    })
    act(() => {
      container!
        .querySelector('.transcript-shell')!
        .dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    expect(tooltip()).toBeNull()
  })

  it('keeps only one tooltip open across several rows', () => {
    render(
      message({
        content: 'first row\nsecond row',
        toolCalls: [
          call({ id: 'call-1', lineIndex: 0, arguments: { query: 'first query' } }),
          call({ id: 'call-2', lineIndex: 1, arguments: { query: 'second query' } }),
        ],
      }),
    )

    act(() => {
      row(0).click()
    })
    expect(tooltip()?.textContent).toContain('first query')

    act(() => {
      row(1).focus()
    })
    expect(container!.querySelectorAll('.tool-progress__tooltip')).toHaveLength(1)
    expect(tooltip()?.textContent).toContain('second query')
    expect(tooltip()?.textContent).not.toContain('first query')
  })

  it('exposes the tool name and full arguments as the accessible description', () => {
    render(message())

    const describedBy = row().getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const description = container!.ownerDocument.getElementById(describedBy!)
    expect(description?.textContent).toContain('search')
    expect(description?.textContent).toContain('find the docs')
  })

  it('renders argument markup as literal text', () => {
    render(
      message({
        content: 'running\n',
        toolCalls: [
          call({
            lineIndex: 0,
            arguments: { body: '<script>window.__pwned = true</script>' },
          }),
        ],
      }),
    )

    act(() => {
      row().click()
    })

    expect(tooltip()?.textContent).toContain('<script>window.__pwned = true</script>')
    expect(container!.innerHTML).not.toContain('<script')
  })

  it('shows the truncation note only when the call is marked truncated', () => {
    render(message({ content: 'running\n', toolCalls: [call({ lineIndex: 0 })] }))
    act(() => {
      row().click()
    })
    expect(tooltip()?.textContent).not.toContain('truncated')

    render(
      message({
        id: 'message-2',
        content: 'running\n',
        toolCalls: [call({ lineIndex: 0, truncated: true })],
      }),
    )
    expect(tooltip()).toBeNull()
    act(() => {
      row().click()
    })
    expect(tooltip()?.textContent).toContain('The server truncated these arguments.')
  })
})

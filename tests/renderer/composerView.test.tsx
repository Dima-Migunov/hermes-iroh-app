import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Composer } from '@renderer/components/Composer'

const send = async (): Promise<boolean> => true
const stop = (): void => undefined

function render(generating = false, disabled = false): string {
  return renderToStaticMarkup(
    <Composer disabled={disabled} generating={generating} onSend={send} onStop={stop} />,
  )
}

function fieldContainsButton(html: string): boolean {
  const fieldStart = html.indexOf('class="composer-field"')
  const fieldEnd = html.indexOf('</div>', fieldStart)
  const buttonStart = html.indexOf('<button', fieldStart)
  return fieldStart !== -1 && buttonStart !== -1 && buttonStart < fieldEnd
}

function buttonMarkup(html: string): string {
  const buttonStart = html.indexOf('<button')
  const buttonEnd = html.indexOf('</button>', buttonStart)
  return html.slice(buttonStart, buttonEnd)
}

function textareaMarkup(html: string): string {
  const textareaStart = html.indexOf('<textarea')
  const textareaEnd = html.indexOf('</textarea>', textareaStart)
  return html.slice(textareaStart, textareaEnd)
}

describe('Composer send action', () => {
  it('renders an arrow button inside the message field', () => {
    const html = render()

    expect(html).toContain('>↑</button>')
    expect(html).toContain('aria-label="Send"')
    expect(html).toContain('title="Send"')
    expect(html).not.toContain('>Send</button>')
    expect(fieldContainsButton(html)).toBe(true)
  })

  it('replaces the arrow with a stop icon inside the field while generating', () => {
    const html = render(true)

    expect(html).toContain('>■</button>')
    expect(html).not.toContain('>Stop</button>')
    expect(html).toContain('aria-label="Stop"')
    expect(html).toContain('title="Stop"')
    expect(fieldContainsButton(html)).toBe(true)
  })
})

describe('Composer primary action availability', () => {
  it('stays enabled with the same submit type when the field is empty', () => {
    const html = render()

    expect(buttonMarkup(html)).not.toContain('disabled')
    expect(buttonMarkup(html)).toContain('type="submit"')
  })

  it('stays enabled while the composer is otherwise unavailable', () => {
    const html = render(false, true)

    expect(buttonMarkup(html)).not.toContain('disabled')
  })
})

describe('Composer message field', () => {
  it('stays enabled and focusable while a prompt is generating', () => {
    const html = render(true)

    expect(textareaMarkup(html)).not.toContain('disabled')
    expect(html).toContain('placeholder="Ask the agent…"')
  })

  it('is disabled only when there is no active session', () => {
    const html = render(false, true)

    expect(textareaMarkup(html)).toContain('disabled')
    expect(html).toContain('placeholder="Waiting for a session…"')
  })
})

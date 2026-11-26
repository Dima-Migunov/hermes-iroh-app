import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')

function cssRule(selector) {
  const start = css.indexOf(`${selector} {`)
  expect(start, `missing CSS rule for ${selector}`).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}

function reducedMotionBlock() {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)')
  expect(start).toBeGreaterThan(-1)
  return css.slice(start)
}

describe('reduced motion styles', () => {
  it('disables the streaming caret animation', () => {
    const block = reducedMotionBlock()

    expect(block).toMatch(/\.streaming-caret\s*\{[^}]*animation:\s*none/)
  })

  it('keeps the caret visible so the streaming state is still conveyed', () => {
    expect(reducedMotionBlock()).toMatch(/\.streaming-caret\s*\{[^}]*visibility:\s*visible/)
  })

  it('still disables the sidebar transitions', () => {
    expect(reducedMotionBlock()).toMatch(/\.sidebar[\s,]/)
    expect(reducedMotionBlock()).toMatch(/transition:\s*none/)
  })

  it('disables the session action cross-fade', () => {
    const block = reducedMotionBlock()

    expect(block).toMatch(/\.session-actions-trigger,[\s\S]*?\.session-actions-menu[\s\S]*?transition:\s*none/)
  })
})

describe('session row actions', () => {
  it('reserves a fixed action slot beside the select button', () => {
    expect(cssRule('.session-row')).toMatch(/position:\s*relative/)
    expect(cssRule('.session-button')).toMatch(/padding:\s*8px 62px 8px 10px/)
    expect(cssRule('.session-actions')).toMatch(/position:\s*absolute/)
    expect(cssRule('.session-actions')).toMatch(/width:\s*52px/)
  })

  it('cross-fades the trigger into the rename and delete controls', () => {
    expect(css).toMatch(/\.session-actions-trigger,[\s\S]*?opacity 120ms ease/)
    expect(css).toMatch(/\.session-actions--open \.session-actions-trigger\s*\{[^}]*opacity:\s*0/)
    expect(css).toMatch(/\.session-actions--open \.session-actions-menu\s*\{[^}]*opacity:\s*1/)
  })

  it('styles the destructive confirmation distinctly', () => {
    expect(cssRule('.session-delete-confirm')).toMatch(/border:\s*1px solid var\(--danger\)/)
    expect(cssRule('.danger-button')).toMatch(/color:\s*var\(--danger\)/)
  })
})

describe('composer send button focus', () => {
  it('restores a visible focus ring', () => {
    const start = css.indexOf('.composer-send-button:focus')
    expect(start).toBeGreaterThan(-1)
    const rule = css.slice(start, css.indexOf('}', start))

    expect(rule).toContain('outline: 2px solid var(--accent)')
    expect(rule).not.toContain('outline: none')
  })
})

describe('user message rail', () => {
  it('overlays the transcript gutter without taking pointer events from the chat', () => {
    const rail = cssRule('.user-message-rail')

    expect(rail).toMatch(/position:\s*absolute/)
    expect(rail).toMatch(/pointer-events:\s*none/)
    expect(rail).not.toMatch(/overflow-y:\s*auto/)
  })

  it('gives each marker a clickable hit area', () => {
    const marker = cssRule('.user-message-rail__marker')

    expect(marker).toMatch(/pointer-events:\s*auto/)
    expect(marker).toMatch(/width:\s*16px/)
  })

  it('shows a visible focus ring on the marker buttons', () => {
    const start = css.indexOf('.user-message-rail__marker:focus-visible')
    expect(start).toBeGreaterThan(-1)
    const rule = css.slice(start, css.indexOf('}', start))

    expect(rule).toContain('outline: 2px solid var(--accent)')
  })

  it('bounds the tooltip and fades truncated text', () => {
    const tooltip = cssRule('.user-message-rail__tooltip')

    expect(tooltip).toMatch(/width:\s*max-content/)
    expect(tooltip).toMatch(/max-height:\s*50%/)
    expect(tooltip).toMatch(/overflow:\s*hidden/)
    expect(css).toMatch(/\.user-message-rail__tooltip::after\s*\{[^}]*linear-gradient/)
  })

  it('removes rail transitions under reduced motion without hiding anything', () => {
    const block = reducedMotionBlock()

    expect(block).toMatch(
      /\.user-message-rail__marker,[\s\S]*?\.user-message-rail__line[\s\S]*?\.user-message-rail__tooltip[\s\S]*?transition:\s*none/,
    )
    expect(block).not.toMatch(/\.user-message-rail[^}]*visibility:\s*hidden/)
  })
})

describe('sidebar session scrolling', () => {
  it('clips outer overflow so the sidebar remains the fixed viewport', () => {
    const rule = cssRule('.sidebar')

    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).not.toMatch(/overflow-y:\s*auto/)
  })

  it.each(['.brand', '.sidebar-footer'])('%s stays anchored instead of shrinking', (selector) => {
    expect(cssRule(selector)).toMatch(/flex-shrink:\s*0/)
  })

  it('lets the session wrapper flex within the remaining height', () => {
    const rule = cssRule('.sidebar-sessions')

    expect(rule).toMatch(/flex:\s*1 1 auto/)
    expect(rule).toMatch(/min-height:\s*0/)
    expect(rule).toMatch(/grid-template-rows:\s*1fr/)
  })

  it('keeps the Sessions heading out of the scrolling surface', () => {
    const nav = cssRule('.sidebar-sessions > .sessions')
    const heading = cssRule('.sessions-heading')

    expect(nav).toMatch(/min-height:\s*0/)
    expect(nav).toMatch(/overflow:\s*hidden/)
    expect(nav).not.toMatch(/overflow-y:\s*auto/)
    expect(heading).toMatch(/flex:\s*none/)
  })

  it('makes the session list the vertical scroll container', () => {
    const rule = cssRule('.session-list')

    expect(rule).toMatch(/overflow-y:\s*auto/)
    expect(rule).toMatch(/min-height:\s*0/)
  })

  it('preserves the collapsing grid row and hidden rail state', () => {
    const wrapper = cssRule('.sidebar-sessions')
    const rail = cssRule('.sidebar--rail .sidebar-sessions')

    expect(wrapper).toMatch(/transition:[\s\S]*grid-template-rows/)
    expect(rail).toMatch(/grid-template-rows:\s*0fr/)
    expect(rail).toMatch(/visibility:\s*hidden/)
    expect(rail).toMatch(/pointer-events:\s*none/)
  })
})

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

  it('makes the Sessions navigation the vertical scroll container', () => {
    const rule = cssRule('.sidebar-sessions > .sessions')

    expect(rule).toMatch(/overflow-y:\s*auto/)
    expect(rule).toMatch(/min-height:\s*0/)
    expect(rule).not.toMatch(/overflow:\s*hidden/)
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

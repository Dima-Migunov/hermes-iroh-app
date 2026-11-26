import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')

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

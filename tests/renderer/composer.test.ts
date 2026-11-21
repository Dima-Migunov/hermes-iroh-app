import { describe, expect, it } from 'vitest'
import { composerAction, isCancelKey, isSubmittable } from '@renderer/composer'

describe('composerAction', () => {
  it('sends on Enter', () => {
    expect(composerAction({ key: 'Enter', shiftKey: false })).toBe('send')
  })

  it('inserts a newline on Shift+Enter', () => {
    expect(composerAction({ key: 'Enter', shiftKey: true })).toBe('newline')
  })

  it('ignores Enter during IME composition', () => {
    expect(composerAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBe('none')
  })

  it('ignores other keys', () => {
    expect(composerAction({ key: 'a', shiftKey: false })).toBe('none')
    expect(composerAction({ key: 'Escape', shiftKey: false })).toBe('none')
  })
})

describe('isCancelKey', () => {
  it('accepts Escape outside composition', () => {
    expect(isCancelKey({ key: 'Escape' })).toBe(true)
    expect(isCancelKey({ key: 'Escape', isComposing: false })).toBe(true)
  })

  it('ignores other keys and Escape during composition', () => {
    expect(isCancelKey({ key: 'Enter' })).toBe(false)
    expect(isCancelKey({ key: 'a' })).toBe(false)
    expect(isCancelKey({ key: 'Escape', isComposing: true })).toBe(false)
  })
})

describe('isSubmittable', () => {
  it('rejects empty and whitespace-only input', () => {
    expect(isSubmittable('')).toBe(false)
    expect(isSubmittable('   ')).toBe(false)
    expect(isSubmittable('\n\t ')).toBe(false)
  })

  it('accepts text with surrounding whitespace', () => {
    expect(isSubmittable(' hi ')).toBe(true)
    expect(isSubmittable('line one\nline two')).toBe(true)
  })
})

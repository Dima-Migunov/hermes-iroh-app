import { describe, expect, it } from 'vitest'
import { formatWindowTitle } from '@renderer/connection'

describe('formatWindowTitle', () => {
  it.each([
    ['disconnected', 'Hermes Iroh App — Disconnected'],
    ['connecting', 'Hermes Iroh App — Connecting…'],
    ['connected', 'Hermes Iroh App — Connected'],
    ['error', 'Hermes Iroh App — Error'],
  ] as const)('formats the %s state', (state, expected) => {
    expect(formatWindowTitle(state)).toBe(expected)
  })
})

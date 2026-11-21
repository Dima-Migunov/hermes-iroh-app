import { describe, expect, it } from 'vitest'
import { formatWindowTitle } from '@renderer/connection'

describe('formatWindowTitle', () => {
  it.each([
    ['disconnected', 'Iroh Channel — Disconnected'],
    ['connecting', 'Iroh Channel — Connecting…'],
    ['connected', 'Iroh Channel — Connected'],
    ['error', 'Iroh Channel — Error'],
  ] as const)('formats the %s state', (state, expected) => {
    expect(formatWindowTitle(state)).toBe(expected)
  })
})

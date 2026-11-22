import { describe, expect, it } from 'vitest'
import { formatWindowTitle } from '@renderer/connection'

describe('formatWindowTitle', () => {
  const version = '1.2.3'
  it.each([
    ['disconnected', `Hermes Iroh: ${version} - Disconnected`],
    ['connecting', `Hermes Iroh: ${version} - Connecting…`],
    ['connected', `Hermes Iroh: ${version} - Connected`],
    ['error', `Hermes Iroh: ${version} - Error`],
  ] as const)('formats the %s state', (state, expected) => {
    expect(formatWindowTitle(state, version)).toBe(expected)
  })
})

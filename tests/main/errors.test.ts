import { describe, expect, it } from 'vitest'
import { AppError, mapIrohError, serverErrorMessage } from '@main/errors'

describe('mapIrohError', () => {
  it('classifies timeouts', () => {
    const mapped = mapIrohError(new Error('connection timed out'))
    expect(mapped.code).toBe('timeout')
    expect(mapped.message).toMatch(/timed out/i)
  })

  it('classifies relay and network failures', () => {
    expect(mapIrohError(new Error('relay unreachable')).code).toBe('network')
    expect(mapIrohError(new Error('DNS lookup failed')).code).toBe('network')
  })

  it('classifies refused and reset connections', () => {
    expect(mapIrohError(new Error('connection refused')).code).toBe('connection-refused')
    expect(mapIrohError(new Error('connection reset by peer')).code).toBe('connection-refused')
  })

  it('adds the allowlist hint for an early close', () => {
    const mapped = mapIrohError(new Error('connection closed'), {
      closedBeforeResponse: true,
    })
    expect(mapped.code).toBe('connection-closed')
    expect(mapped.message).toContain('/iroh_allow')
  })

  it('omits the allowlist hint for a close after streaming began', () => {
    const mapped = mapIrohError(new Error('connection closed'))
    expect(mapped.code).toBe('connection-closed')
    expect(mapped.message).not.toContain('/iroh_allow')
  })

  it('preserves typed application errors', () => {
    const original = new AppError('configuration', 'bad settings')
    expect(mapIrohError(original)).toBe(original)
  })

  it('converts unknown failures into a network error', () => {
    const mapped = mapIrohError(new Error('something unusual'))
    expect(mapped.code).toBe('network')
    expect(mapped.message).toContain('something unusual')
  })

  it('preserves server error messages', () => {
    const error = serverErrorMessage('the model is unavailable')
    expect(error.code).toBe('server')
    expect(error.message).toBe('the model is unavailable')
  })
})

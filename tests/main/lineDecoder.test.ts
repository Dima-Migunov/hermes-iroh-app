import { describe, expect, it } from 'vitest'
import { AppError } from '@main/errors'
import { LineDecoder } from '@main/lineDecoder'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('LineDecoder', () => {
  it('decodes a multibyte character split across reads', () => {
    const decoder = new LineDecoder()
    const bytes = encode('héllo\n')

    expect(decoder.push(bytes.slice(0, 2))).toEqual([])
    expect(decoder.push(bytes.slice(2))).toEqual(['héllo'])
  })

  it('buffers a frame split across reads', () => {
    const decoder = new LineDecoder()
    expect(decoder.push(encode('{"type":"del'))).toEqual([])
    expect(decoder.push(encode('ta","content":"hi"}\n'))).toEqual([
      '{"type":"delta","content":"hi"}',
    ])
  })

  it('returns multiple frames from one read', () => {
    const decoder = new LineDecoder()
    expect(decoder.push(encode('one\ntwo\nthree\n'))).toEqual(['one', 'two', 'three'])
  })

  it('strips a trailing carriage return', () => {
    const decoder = new LineDecoder()
    expect(decoder.push(encode('{"a":1}\r\n'))).toEqual(['{"a":1}'])
  })

  it('returns an empty list at EOF without buffered data', () => {
    const decoder = new LineDecoder()
    expect(decoder.end()).toEqual([])
  })

  it('flushes a trailing line without a newline at EOF', () => {
    const decoder = new LineDecoder()
    decoder.push(encode('{"a":'))
    expect(decoder.end()).toEqual(['{"a":'])
  })

  it('rejects a line over the 1 MiB cap', () => {
    const decoder = new LineDecoder()
    const oversized = new Uint8Array(1024 * 1024 + 1).fill(0x61)

    expect(() => decoder.push(oversized)).toThrowError(AppError)
    try {
      decoder.push(oversized)
    } catch (error) {
      expect((error as AppError).code).toBe('protocol')
    }
  })

  it('rejects invalid UTF-8', () => {
    const decoder = new LineDecoder()
    const invalid = new Uint8Array([0xff, 0xfe, 0x0a])

    expect(() => decoder.push(invalid)).toThrowError(/invalid UTF-8/i)
  })
})

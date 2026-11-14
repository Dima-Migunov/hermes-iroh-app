import { AppError } from './errors'

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024

export class LineDecoder {
  private pending: Uint8Array = new Uint8Array(0)
  private readonly maxLineBytes: number
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes
  }

  push(chunk: Uint8Array): string[] {
    if (this.pending.length === 0) {
      this.pending = chunk.slice()
    } else {
      const combined = new Uint8Array(this.pending.length + chunk.length)
      combined.set(this.pending, 0)
      combined.set(chunk, this.pending.length)
      this.pending = combined
    }

    const lines: string[] = []
    let start = 0

    for (let index = 0; index < this.pending.length; index += 1) {
      if (this.pending[index] !== 0x0a) continue

      const lineBytes = this.pending.subarray(start, index)
      if (lineBytes.length > this.maxLineBytes) {
        throw new AppError('protocol', `A response line exceeded the ${this.maxLineBytes}-byte limit.`)
      }
      lines.push(this.decode(lineBytes))
      start = index + 1
    }

    this.pending = this.pending.slice(start)

    if (this.pending.length > this.maxLineBytes) {
      throw new AppError('protocol', `A response line exceeded the ${this.maxLineBytes}-byte limit.`)
    }

    return lines
  }

  end(): string[] {
    if (this.pending.length === 0) return []

    if (this.pending.length > this.maxLineBytes) {
      throw new AppError('protocol', `A response line exceeded the ${this.maxLineBytes}-byte limit.`)
    }

    const line = this.decode(this.pending)
    this.pending = new Uint8Array(0)
    return [line]
  }

  private decode(bytes: Uint8Array): string {
    let end = bytes.length
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1
    try {
      return this.decoder.decode(bytes.subarray(0, end))
    } catch {
      throw new AppError('protocol', 'The server sent invalid UTF-8.')
    }
  }
}

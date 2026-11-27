import type { ToolCall } from '@shared/protocol'

export const TRUNCATED_ARGUMENTS_NOTE = 'The server truncated these arguments.'

export interface MarkdownSegment {
  kind: 'markdown'
  content: string
}

export interface ToolSegment {
  kind: 'tool'
  call: ToolCall
  text: string
  lineIndex: number
}

export type MessageSegment = MarkdownSegment | ToolSegment

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A single string argument (such as a search query) is shown as its complete
 * text. Everything else is labelled per key, with nested values pretty-printed.
 */
export function formatToolArguments(argumentsValue: Record<string, unknown>): string {
  const entries = Object.entries(argumentsValue)
  if (entries.length === 1 && typeof entries[0]?.[1] === 'string') {
    return entries[0][1]
  }
  return entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join('\n')
}

export function describeToolCall(call: ToolCall): string {
  const description = `${call.name}\n${formatToolArguments(call.arguments)}`
  return call.truncated ? `${description}\n${TRUNCATED_ARGUMENTS_NOTE}` : description
}

function isUsableCall(call: ToolCall, lines: string[]): boolean {
  if (typeof call.name !== 'string' || call.name.length === 0) return false
  if (!Number.isInteger(call.lineIndex) || call.lineIndex < 0 || call.lineIndex >= lines.length) {
    return false
  }
  if (lines[call.lineIndex].trim().length === 0) return false
  const argumentsValue: unknown = call.arguments
  if (
    typeof argumentsValue !== 'object' ||
    argumentsValue === null ||
    Array.isArray(argumentsValue)
  ) {
    return false
  }
  return Object.keys(argumentsValue).length > 0
}

/**
 * Splits the message into Markdown groups and tool-progress rows. An empty
 * result means the caller must keep the ordinary whole-content Markdown path.
 */
export function buildMessageSegments(
  content: string,
  calls: ToolCall[] | undefined,
): MessageSegment[] {
  if (!calls || calls.length === 0) return []

  const lines = content.split('\n')
  const byLine = new Map<number, ToolCall>()
  const seenIds = new Set<string>()
  for (const call of [...calls].sort((left, right) => left.lineIndex - right.lineIndex)) {
    if (!isUsableCall(call, lines)) continue
    if (call.id !== undefined) {
      if (seenIds.has(call.id)) continue
      seenIds.add(call.id)
    }
    if (!byLine.has(call.lineIndex)) byLine.set(call.lineIndex, call)
  }
  if (byLine.size === 0) return []

  const segments: MessageSegment[] = []
  let markdown: string[] = []
  const flushMarkdown = (): void => {
    if (markdown.length === 0) return
    segments.push({ kind: 'markdown', content: markdown.join('\n') })
    markdown = []
  }

  lines.forEach((line, index) => {
    const call = byLine.get(index)
    if (call) {
      flushMarkdown()
      segments.push({ kind: 'tool', call, text: line, lineIndex: index })
    } else {
      markdown.push(line)
    }
  })
  flushMarkdown()

  return segments
}

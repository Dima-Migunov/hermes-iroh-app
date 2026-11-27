import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/protocol'
import {
  TRUNCATED_ARGUMENTS_NOTE,
  buildMessageSegments,
  describeToolCall,
  formatToolArguments,
} from '@renderer/toolCalls'

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    name: 'search',
    arguments: { query: 'docs' },
    truncated: false,
    lineIndex: 1,
    ...overrides,
  }
}

describe('formatToolArguments', () => {
  it('shows a single string argument as its complete text', () => {
    expect(formatToolArguments({ query: 'find the install guide' })).toBe(
      'find the install guide',
    )
  })

  it('labels multiple arguments and pretty-prints nested values', () => {
    const formatted = formatToolArguments({
      query: 'docs',
      filter: { kind: 'page', tags: ['guide', 'api'] },
      limit: 5,
      exact: true,
    })

    expect(formatted).toContain('query: docs')
    expect(formatted).toContain('limit: 5')
    expect(formatted).toContain('exact: true')
    expect(formatted).toContain('filter: {')
    expect(formatted).toContain('"kind": "page"')
    expect(formatted).toContain('"tags": [')
  })

  it('keeps redaction markers literal', () => {
    const formatted = formatToolArguments({
      token: '[redacted]',
      body: '[omitted]',
    })

    expect(formatted).toContain('token: [redacted]')
    expect(formatted).toContain('body: [omitted]')
  })

  it('never serializes a single string argument as JSON', () => {
    expect(formatToolArguments({ body: '<b>literal</b>' })).toBe('<b>literal</b>')
  })
})

describe('describeToolCall', () => {
  it('includes the tool name and complete arguments', () => {
    const description = describeToolCall(call({ arguments: { query: 'find the docs' } }))

    expect(description).toContain('search')
    expect(description).toContain('find the docs')
  })

  it('adds the truncation note only when the server marked the call', () => {
    expect(describeToolCall(call({ truncated: true }))).toContain(
      TRUNCATED_ARGUMENTS_NOTE,
    )
    expect(describeToolCall(call())).not.toContain(TRUNCATED_ARGUMENTS_NOTE)
  })
})

describe('buildMessageSegments', () => {
  const content = 'first line\nsearching the docs\nlast line'

  it('splits Markdown around a tool-linked line in order', () => {
    const segments = buildMessageSegments(content, [call({ lineIndex: 1 })])

    expect(segments).toEqual([
      { kind: 'markdown', content: 'first line' },
      {
        kind: 'tool',
        call: call({ lineIndex: 1 }),
        text: 'searching the docs',
        lineIndex: 1,
      },
      { kind: 'markdown', content: 'last line' },
    ])
  })

  it('keeps the exact received line text', () => {
    const segments = buildMessageSegments('  - searching…  \nnext', [
      call({ lineIndex: 0 }),
    ])

    expect(segments[0]).toMatchObject({ kind: 'tool', text: '  - searching…  ' })
  })

  it('returns nothing when there are no calls', () => {
    expect(buildMessageSegments(content, undefined)).toEqual([])
    expect(buildMessageSegments(content, [])).toEqual([])
  })

  it('ignores stale, blank, and argument-less calls', () => {
    expect(buildMessageSegments(content, [call({ lineIndex: 9 })])).toEqual([])
    expect(buildMessageSegments('one\n\nthree', [call({ lineIndex: 1 })])).toEqual([])
    expect(buildMessageSegments(content, [call({ arguments: {} })])).toEqual([])
    expect(
      buildMessageSegments(content, [
        call({ arguments: [] as unknown as Record<string, unknown> }),
      ]),
    ).toEqual([])
  })

  it('keeps one row per line when two calls target the same line', () => {
    const segments = buildMessageSegments(content, [
      call({ lineIndex: 1 }),
      call({ id: 'call-2', lineIndex: 1, name: 'second call' }),
    ])

    expect(segments.filter((segment) => segment.kind === 'tool')).toHaveLength(1)
    expect(segments[1]).toMatchObject({ kind: 'tool', text: 'searching the docs' })
    expect(segments[1]).toMatchObject({ call: { name: 'search' } })
  })

  it('ignores a duplicate id on a later line', () => {
    const segments = buildMessageSegments(content, [
      call({ id: 'shared', lineIndex: 1 }),
      call({ id: 'shared', lineIndex: 2, name: 'duplicate id' }),
    ])

    expect(segments.filter((segment) => segment.kind === 'tool')).toHaveLength(1)
    expect(segments[1]).toMatchObject({ kind: 'tool', text: 'searching the docs' })
  })

  it('renders a call on every line independently including the first and last', () => {
    const segments = buildMessageSegments('first\nmiddle\nlast', [
      call({ id: 'first', lineIndex: 0 }),
      call({ id: 'last', lineIndex: 2 }),
    ])

    expect(segments.map((segment) => segment.kind)).toEqual(['tool', 'markdown', 'tool'])
    expect(segments[0]).toMatchObject({ lineIndex: 0, text: 'first' })
    expect(segments[1]).toMatchObject({ kind: 'markdown', content: 'middle' })
    expect(segments[2]).toMatchObject({ lineIndex: 2, text: 'last' })
  })
})

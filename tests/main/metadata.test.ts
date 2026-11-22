import { describe, expect, it } from 'vitest'
import { normalizeResponseMetadata } from '@shared/metadata'

const required = {
  schema: 1,
  generated_at: '2026-11-21T12:00:00.000Z',
  latency_ms: 812,
}

const fullMetadata = {
  ...required,
  model: 'gpt-5.1',
  provider: 'openai',
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    reasoning_tokens: 12,
    cache_read_tokens: 40,
    cache_write_tokens: 8,
  },
  session_usage: {
    input_tokens: 10200,
    output_tokens: 2400,
    total_tokens: 12600,
    api_calls: 8,
    estimated_cost_usd: 0.42,
    cost_status: 'estimated',
    cost_source: 'model_catalog',
    context_tokens: 8400,
    context_length: 128000,
    context_percent: 6.6,
  },
  balance: {
    provider: 'nous',
    remaining_micros: 12500000,
    remaining_usd: 12.5,
    subscription_micros: 1000000,
    subscription_usd: 1,
    subscription_limit_usd: 10,
    purchased_micros: 500000,
    purchased_usd: 0.5,
    paid_access: true,
    as_of_ms: 1763726400000,
    plan_gauge: {
      id: 'plan-1',
      label: 'Pro',
      used_bp: 1250,
      resets_at_ms: 1766320000000,
    },
  },
}

describe('normalizeResponseMetadata', () => {
  it('returns every recognized field for a complete object', () => {
    expect(normalizeResponseMetadata(fullMetadata)).toEqual(fullMetadata)
  })

  it.each([null, undefined, 'metadata', 42, [], true])(
    'rejects a non-object value: %s',
    (value) => {
      expect(normalizeResponseMetadata(value)).toBeUndefined()
    },
  )

  it('rejects a value that is not an object before reading the schema', () => {
    expect(normalizeResponseMetadata({ ...required, schema: '1' })).toBeUndefined()
    expect(normalizeResponseMetadata({ ...required, schema: 1.5 })).toBeUndefined()
    expect(normalizeResponseMetadata({ generated_at: required.generated_at, latency_ms: 1 })).toBe(
      undefined,
    )
    expect(normalizeResponseMetadata({ schema: 1, latency_ms: 1 })).toBeUndefined()
    expect(normalizeResponseMetadata({ schema: 1, generated_at: required.generated_at })).toBe(
      undefined,
    )
  })

  it.each([
    'not a timestamp',
    '2026-11-21',
    '2026-11-21T12:00:00',
    '2026-11-21T12:00:00+01:00',
    '2026-13-01T00:00:00.000Z',
    1763726400000,
  ])('rejects an invalid generated_at: %s', (generatedAt) => {
    expect(
      normalizeResponseMetadata({ ...required, generated_at: generatedAt }),
    ).toBeUndefined()
  })

  it('accepts a +00:00 UTC designator in generated_at', () => {
    const metadata = normalizeResponseMetadata({
      ...required,
      generated_at: '2026-11-21T12:00:00+00:00',
    })

    expect(metadata?.generated_at).toBe('2026-11-21T12:00:00+00:00')
  })

  it.each([-1, 1.5, '812', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid latency_ms: %s',
    (latency) => {
      expect(normalizeResponseMetadata({ ...required, latency_ms: latency })).toBeUndefined()
    },
  )

  it('accepts a newer integer schema and drops unknown fields at every level', () => {
    const metadata = normalizeResponseMetadata({
      ...fullMetadata,
      schema: 2,
      extra: 'top-level',
      usage: { ...fullMetadata.usage, unknown_counter: 5 },
      session_usage: { ...fullMetadata.session_usage, unknown_session: 'value' },
      balance: { ...fullMetadata.balance, unknown_balance: true },
      plan_gauge: undefined,
    })

    expect(metadata).toEqual({ ...fullMetadata, schema: 2 })
  })

  it('drops unknown nested fields without copying them', () => {
    const metadata = normalizeResponseMetadata({
      ...required,
      usage: { input_tokens: 3, unknown_counter: 5 },
      session_usage: { total_tokens: 9, unknown_session: 'value' },
      balance: {
        remaining_usd: 1.25,
        unknown_balance: true,
        plan_gauge: { label: 'Pro', unknown_gauge: 1 },
      },
    })

    expect(metadata).toEqual({
      ...required,
      usage: { input_tokens: 3 },
      session_usage: { total_tokens: 9 },
      balance: { remaining_usd: 1.25, plan_gauge: { label: 'Pro' } },
    })
  })

  it('keeps valid groups when another optional group is malformed', () => {
    const metadata = normalizeResponseMetadata({
      ...required,
      usage: 'not an object',
      session_usage: { input_tokens: 10, output_tokens: 'many', total_tokens: -1 },
      balance: { remaining_micros: 5000000, paid_access: 'yes', as_of_ms: -5 },
    })

    expect(metadata).toEqual({
      ...required,
      session_usage: { input_tokens: 10 },
      balance: { remaining_micros: 5000000 },
    })
  })

  it('drops counters with malformed values individually', () => {
    const metadata = normalizeResponseMetadata({
      ...required,
      usage: {
        input_tokens: 10,
        output_tokens: 'ten',
        total_tokens: Number.NaN,
        reasoning_tokens: -3,
        cache_read_tokens: 4,
      },
    })

    expect(metadata?.usage).toEqual({ input_tokens: 10, cache_read_tokens: 4 })
  })

  it('omits empty optional objects instead of inventing placeholders', () => {
    const metadata = normalizeResponseMetadata({
      ...required,
      usage: {},
      session_usage: { cost_status: 5 },
      balance: { paid_access: null },
    })

    expect(metadata).toEqual(required)
  })

  it('accepts zero-valued counters and zero latency', () => {
    const metadata = normalizeResponseMetadata({
      ...required,
      latency_ms: 0,
      usage: { input_tokens: 0, total_tokens: 0 },
      session_usage: { context_percent: 0, estimated_cost_usd: 0 },
      balance: { remaining_usd: 0 },
    })

    expect(metadata).toEqual({
      ...required,
      latency_ms: 0,
      usage: { input_tokens: 0, total_tokens: 0 },
      session_usage: { context_percent: 0, estimated_cost_usd: 0 },
      balance: { remaining_usd: 0 },
    })
  })

  it('never throws for unusual nested values', () => {
    expect(() =>
      normalizeResponseMetadata({
        ...required,
        usage: { input_tokens: {} },
        session_usage: [],
        balance: { plan_gauge: [] },
      }),
    ).not.toThrow()
  })
})

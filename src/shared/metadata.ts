import type {
  AccountBalance,
  PlanGauge,
  ResponseMetadata,
  SessionUsage,
  TokenUsage,
} from './protocol'

const TOKEN_COUNTER_KEYS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
] as const

const SESSION_COUNTER_KEYS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'api_calls',
  'context_tokens',
  'context_length',
] as const

const BALANCE_AMOUNT_KEYS = [
  'remaining_micros',
  'remaining_usd',
  'subscription_micros',
  'subscription_usd',
  'subscription_limit_usd',
  'purchased_micros',
  'purchased_usd',
  'as_of_ms',
] as const

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]00:00)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function hasFields(value: object): boolean {
  return Object.keys(value).length > 0
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined

  const usage: TokenUsage = {}
  for (const key of TOKEN_COUNTER_KEYS) {
    const counter = amount(value[key])
    if (counter !== undefined) usage[key] = counter
  }
  return hasFields(usage) ? usage : undefined
}

function normalizeSessionUsage(value: unknown): SessionUsage | undefined {
  if (!isRecord(value)) return undefined

  const usage: SessionUsage = {}
  for (const key of SESSION_COUNTER_KEYS) {
    const counter = amount(value[key])
    if (counter !== undefined) usage[key] = counter
  }

  const estimatedCost = amount(value.estimated_cost_usd)
  if (estimatedCost !== undefined) usage.estimated_cost_usd = estimatedCost
  const contextPercent = amount(value.context_percent)
  if (contextPercent !== undefined) usage.context_percent = contextPercent
  const costStatus = text(value.cost_status)
  if (costStatus !== undefined) usage.cost_status = costStatus
  const costSource = text(value.cost_source)
  if (costSource !== undefined) usage.cost_source = costSource

  return hasFields(usage) ? usage : undefined
}

function normalizePlanGauge(value: unknown): PlanGauge | undefined {
  if (!isRecord(value)) return undefined

  const gauge: PlanGauge = {}
  const id = text(value.id)
  if (id !== undefined) gauge.id = id
  const label = text(value.label)
  if (label !== undefined) gauge.label = label
  const usedBp = amount(value.used_bp)
  if (usedBp !== undefined) gauge.used_bp = usedBp
  const resetsAtMs = amount(value.resets_at_ms)
  if (resetsAtMs !== undefined) gauge.resets_at_ms = resetsAtMs

  return hasFields(gauge) ? gauge : undefined
}

function normalizeBalance(value: unknown): AccountBalance | undefined {
  if (!isRecord(value)) return undefined

  const balance: AccountBalance = {}
  const provider = text(value.provider)
  if (provider !== undefined) balance.provider = provider

  for (const key of BALANCE_AMOUNT_KEYS) {
    const field = amount(value[key])
    if (field !== undefined) balance[key] = field
  }

  if (typeof value.paid_access === 'boolean') balance.paid_access = value.paid_access

  const planGauge = normalizePlanGauge(value.plan_gauge)
  if (planGauge) balance.plan_gauge = planGauge

  return hasFields(balance) ? balance : undefined
}

export function normalizeResponseMetadata(value: unknown): ResponseMetadata | undefined {
  try {
    if (!isRecord(value)) return undefined
    if (!isInteger(value.schema)) return undefined
    if (!isIsoUtc(value.generated_at)) return undefined
    if (!isInteger(value.latency_ms) || value.latency_ms < 0) return undefined

    const metadata: ResponseMetadata = {
      schema: value.schema,
      generated_at: value.generated_at,
      latency_ms: value.latency_ms,
    }

    const model = text(value.model)
    if (model !== undefined) metadata.model = model
    const provider = text(value.provider)
    if (provider !== undefined) metadata.provider = provider

    const usage = normalizeUsage(value.usage)
    if (usage) metadata.usage = usage
    const sessionUsage = normalizeSessionUsage(value.session_usage)
    if (sessionUsage) metadata.session_usage = sessionUsage
    const balance = normalizeBalance(value.balance)
    if (balance) metadata.balance = balance

    return metadata
  } catch {
    return undefined
  }
}

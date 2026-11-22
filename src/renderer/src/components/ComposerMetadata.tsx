import type { ResponseMetadata } from '@shared/protocol'

interface ComposerMetadataProps {
  metadata?: ResponseMetadata
}

const COMPACT_NUMBER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const USD_FORMAT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function ComposerMetadata({ metadata }: ComposerMetadataProps) {
  const text = metadata ? statusText(metadata) : undefined
  if (!text) return null

  return <span className="composer-metadata">{text}</span>
}

export function statusText(metadata: ResponseMetadata): string | undefined {
  const parts: string[] = []

  if (metadata.model) parts.push(metadata.model)

  const context = contextText(metadata)
  if (context) parts.push(context)

  const cost = metadata.session_usage?.estimated_cost_usd
  if (cost !== undefined) parts.push(USD_FORMAT.format(cost))

  return parts.length > 0 ? parts.join(' ') : undefined
}

function contextText(metadata: ResponseMetadata): string | undefined {
  const usage = metadata.session_usage
  if (!usage) return undefined

  const tokens = usage.context_tokens
  const length = usage.context_length
  const percent = usage.context_percent

  if (tokens !== undefined && length !== undefined) {
    return `${COMPACT_NUMBER.format(tokens)} / ${COMPACT_NUMBER.format(length)}${percentText(percent)}`
  }
  if (tokens !== undefined) {
    return `${COMPACT_NUMBER.format(tokens)}${percentText(percent)}`
  }
  if (percent !== undefined) return formatPercent(percent)

  return undefined
}

function percentText(percent: number | undefined): string {
  return percent !== undefined ? ` (${formatPercent(percent)})` : ''
}

function formatPercent(value: number): string {
  return `${PERCENT_FORMAT.format(value)}%`
}

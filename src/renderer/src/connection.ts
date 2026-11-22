import type { ConnectionState } from '@shared/protocol'

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
}

export function connectionLabel(state: ConnectionState): string {
  return CONNECTION_LABELS[state]
}

export function formatWindowTitle(state: ConnectionState, version: string): string {
  return `Hermes Iroh: ${version} - ${connectionLabel(state)}`
}

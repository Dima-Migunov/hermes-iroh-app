import type { ConnectionStatus } from '@shared/protocol'

const LABELS: Record<ConnectionStatus['state'], string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
}

export function StatusIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <div className="status" role="status" aria-live="polite">
      <span className={`status-dot status-dot--${status.state}`} aria-hidden="true" />
      <span className="status-label">{LABELS[status.state]}</span>
      {status.message ? (
        <span className="status-message" title={status.message}>
          {status.message}
        </span>
      ) : null}
    </div>
  )
}

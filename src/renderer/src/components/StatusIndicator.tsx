import type { ConnectionStatus } from '@shared/protocol'
import { connectionLabel } from '../connection'

export function StatusIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <div className="status" role="status" aria-live="polite">
      <span className={`status-dot status-dot--${status.state}`} aria-hidden="true" />
      <span className="status-label">{connectionLabel(status.state)}</span>
      {status.message ? (
        <span className="status-message" title={status.message}>
          {status.message}
        </span>
      ) : null}
    </div>
  )
}

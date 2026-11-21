import { useEffect, useRef } from 'react'
import type { ClientConfig, ConnectionStatus } from '@shared/protocol'
import { SettingsPanel } from './SettingsPanel'
import { StatusIndicator } from './StatusIndicator'

interface SettingsPageProps {
  identityNodeId: string | null
  config: ClientConfig | null
  status: ConnectionStatus
  onSaveConnect: (config: ClientConfig) => Promise<ClientConfig>
  onCopy: (text: string) => Promise<void>
  onBack: () => void
}

export function SettingsPage({
  identityNodeId,
  config,
  status,
  onSaveConnect,
  onCopy,
  onBack,
}: SettingsPageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section className="settings-page" aria-labelledby="settings-page-heading">
      <div className="settings-page-content">
        <div className="settings-page-header">
          <button type="button" className="secondary-button" onClick={onBack}>
            Back
          </button>
          <h2 id="settings-page-heading" ref={headingRef} tabIndex={-1}>
            Settings
          </h2>
        </div>

        <StatusIndicator status={status} />

        <SettingsPanel
          identityNodeId={identityNodeId}
          config={config}
          onSaveConnect={onSaveConnect}
          onCopy={onCopy}
        />
      </div>
    </section>
  )
}

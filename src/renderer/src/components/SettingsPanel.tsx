import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ClientConfig } from '@shared/protocol'
import { CopyButton } from './CopyButton'

interface SettingsPanelProps {
  identityNodeId: string | null
  config: ClientConfig | null
  onSaveConnect: (config: ClientConfig) => Promise<ClientConfig>
  onCopy: (text: string) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SettingsPanel({
  identityNodeId,
  config,
  onSaveConnect,
  onCopy,
}: SettingsPanelProps) {
  const [serverTicket, setServerTicket] = useState(config?.serverTicket ?? '')
  const [serverNodeId, setServerNodeId] = useState(config?.serverNodeId ?? '')
  const [relayUrl, setRelayUrl] = useState(config?.relayUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setServerTicket(config?.serverTicket ?? '')
    setServerNodeId(config?.serverNodeId ?? '')
    setRelayUrl(config?.relayUrl ?? '')
  }, [config])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)

    try {
      await onSaveConnect({
        serverTicket: serverTicket.trim() ? serverTicket.trim() : null,
        serverNodeId: serverNodeId.trim() ? serverNodeId.trim() : null,
        relayUrl: relayUrl.trim() ? relayUrl.trim() : null,
      })
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-heading">
      <h2 id="settings-heading">Connection</h2>

      <div className="identity">
        <span className="field-label">Client NodeId</span>
        <output className="identity-value" aria-label="Client NodeId">
          {identityNodeId ?? 'Loading…'}
        </output>
        {identityNodeId ? (
          <CopyButton text={identityNodeId} label="Copy NodeId" onCopy={onCopy} />
        ) : null}
      </div>

      <form className="settings-form" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="server-ticket">Server ticket</label>
        <input
          id="server-ticket"
          value={serverTicket}
          onChange={(event) => setServerTicket(event.target.value)}
          placeholder="endpoint…"
          autoComplete="off"
          spellCheck={false}
        />

        <label htmlFor="server-node-id">Server NodeId (alternative)</label>
        <input
          id="server-node-id"
          value={serverNodeId}
          onChange={(event) => setServerNodeId(event.target.value)}
          placeholder="Base32 NodeId"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="target-help"
        />
        <p id="target-help" className="field-help">
          Paste a ticket or a NodeId. A ticket is preferred and wins if both fields are filled.
        </p>

        <label htmlFor="relay-url">Relay URL (optional)</label>
        <input
          id="relay-url"
          value={relayUrl}
          onChange={(event) => setRelayUrl(event.target.value)}
          placeholder="https://relay.example"
          autoComplete="off"
          spellCheck={false}
        />

        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save & connect'}
        </button>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  )
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ClientConfig, ConnectionStatus } from '@shared/protocol'
import { SettingsPage } from '@renderer/components/SettingsPage'

const noop = async (): Promise<void> => undefined

const config: ClientConfig = {
  serverTicket: 'ticket-abc',
  serverNodeId: 'node-xyz',
  relayUrl: 'https://relay.example',
}

async function saveConfig(value: ClientConfig): Promise<ClientConfig> {
  return value
}

function render(status: ConnectionStatus = { state: 'disconnected' }): string {
  return renderToStaticMarkup(
    <SettingsPage
      identityNodeId="client-node-id"
      config={config}
      status={status}
      onSaveConnect={saveConfig}
      onCopy={noop}
      onBack={() => undefined}
    />,
  )
}

describe('SettingsPage', () => {
  it('exposes every connection control', () => {
    const html = render()

    expect(html).toContain('>Settings</h2>')
    expect(html).toContain('>Back</button>')
    expect(html).toContain('id="server-ticket"')
    expect(html).toContain('id="server-node-id"')
    expect(html).toContain('id="relay-url"')
    expect(html).toContain('client-node-id')
    expect(html).toContain('>Copy NodeId</button>')
    expect(html).toContain('status-dot--disconnected')
    expect(html).toContain('Save &amp; connect')
  })

  it('shows the connection state and status message', () => {
    const html = render({ state: 'error', message: 'Handshake failed' })

    expect(html).toContain('status-dot--error')
    expect(html).toContain('>Error</span>')
    expect(html).toContain('Handshake failed')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/protocol'
import { Sidebar } from '@renderer/components/Sidebar'

const sessions: SessionSummary[] = [
  {
    id: 'session-1',
    title: 'First session',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
  {
    id: 'session-2',
    title: 'Second session',
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  },
]

function render(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}): string {
  return renderToStaticMarkup(
    <Sidebar
      expanded
      compact={false}
      sessions={sessions}
      activeSessionId="session-1"
      disabled={false}
      version="0.7.2"
      status={{ state: 'connected' }}
      onToggle={() => undefined}
      onCreate={() => undefined}
      onSelect={() => undefined}
      onRename={async () => true}
      onDelete={async () => null}
      onSettings={() => undefined}
      onBackdrop={() => undefined}
      {...overrides}
    />,
  )
}

describe('Sidebar expanded state', () => {
  it('shows the brand, session list, status, and settings action', () => {
    const html = render()

    expect(html).toContain('class="sidebar sidebar--expanded"')
    expect(html).toContain('Hermes Iroh')
    expect(html).toContain('0.7.2')
    expect(html).toContain('>Sessions</h2>')
    expect(html).toContain('First session')
    expect(html).toContain('Second session')
    expect(html).toContain('status-dot--connected')
    expect(html).toContain('>Connected</span>')
    expect(html).toContain('aria-label="Settings"')
    expect(html).not.toContain('sidebar-backdrop')
  })

  it('provides a collapse control that reports the expanded state', () => {
    const html = render()

    expect(html).toContain('aria-label="Collapse sidebar"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-controls="app-sidebar"')
    expect(html).not.toContain('aria-label="Expand sidebar"')
  })
})

describe('Sidebar session actions', () => {
  it('keeps the select control and the action trigger as sibling buttons', () => {
    const html = render()

    expect(html).toContain('class="session-row session-row--active"')
    expect(html).toContain('</button><div class="session-actions">')
    expect(html).toContain('aria-label="Session actions"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Rename session"')
    expect(html).toContain('aria-label="Delete session"')
    expect(html).toMatch(/aria-current="true"/)
  })

  it('marks both action buttons disabled while generation runs', () => {
    const html = render({ disabled: true })

    expect(html).toMatch(/aria-label="Rename session"[^>]*disabled=""/)
    expect(html).toMatch(/aria-label="Delete session"[^>]*disabled=""/)
    expect(html).toMatch(/class="session-button[^"]*"[^>]*disabled=""/)
  })
})

describe('Sidebar rail state', () => {
  it('keeps the essential controls and hides the session list from the accessibility tree', () => {
    const html = render({ expanded: false })

    expect(html).toContain('class="sidebar sidebar--rail"')
    expect(html).toContain('aria-label="Expand sidebar"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Settings"')
    expect(html).toContain('status-dot--connected')
    expect(html).toContain('class="sidebar-sessions" inert="" aria-hidden="true"')
    expect(html).toContain('<div class="brand-banner-wrap" aria-hidden="true">')
  })
})

describe('Sidebar drawer state', () => {
  it('renders a backdrop and the full session list when compact and expanded', () => {
    const html = render({ compact: true, expanded: true })

    expect(html).toContain('class="sidebar sidebar--expanded sidebar--compact"')
    expect(html).toContain('class="sidebar-backdrop"')
    expect(html).toContain('aria-label="Close sidebar"')
    expect(html).toContain('>Sessions</h2>')
    expect(html).toContain('First session')
  })

  it('shows only the rail when compact and closed', () => {
    const html = render({ compact: true, expanded: false })

    expect(html).toContain('class="sidebar sidebar--rail sidebar--compact"')
    expect(html).not.toContain('sidebar-backdrop')
    expect(html).toContain('aria-label="Expand sidebar"')
    expect(html).toContain('class="sidebar-sessions" inert="" aria-hidden="true"')
  })
})

describe('Sidebar accessibility', () => {
  it('keeps the toggle, settings, and status present in both states', () => {
    const expanded = render()
    const rail = render({ expanded: false })

    for (const html of [expanded, rail]) {
      expect(html).toContain('class="sidebar-toggle"')
      expect(html).toContain('type="button"')
      expect(html).toContain('aria-label="Settings"')
      expect(html).toContain('role="status"')
      expect(html).toContain('aria-live="polite"')
      expect(html).toContain('>Connected</span>')
    }
  })

  it('removes session controls from the accessibility tree when collapsed', () => {
    const html = render({ expanded: false })

    expect(html).toMatch(/class="sidebar-sessions" inert="" aria-hidden="true"/)
    expect(html).toContain('aria-label="Chat sessions"')
  })

  it('keeps the session controls reachable when expanded', () => {
    const html = render()

    expect(html).toContain('<div class="sidebar-sessions">')
    expect(html).toContain('<div class="brand-banner-wrap">')
    expect(html).not.toContain('<div class="sidebar-sessions" inert')
  })
})

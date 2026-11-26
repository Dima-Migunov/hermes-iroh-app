import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptEvent, SessionSummary } from '@shared/protocol'
import App from '@renderer/App'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const session: SessionSummary = {
  id: 'session-a',
  title: 'Session A',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
}

const api = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  getConnectionStatus: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  activateSession: vi.fn(),
  getSession: vi.fn(),
  getActiveSession: vi.fn(),
  getNotices: vi.fn(),
  sendPrompt: vi.fn(),
  cancelPrompt: vi.fn(),
  copyText: vi.fn(),
  onPromptEvent: vi.fn(),
  onConnectionStatus: vi.fn(),
  onHistoryChanged: vi.fn(),
  onNotice: vi.fn(),
}))

vi.mock('@renderer/bridge', () => ({ bridge: api }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '9.9.9') }))

beforeEach(() => {
  vi.clearAllMocks()
  api.getIdentity.mockResolvedValue({ nodeId: 'client-node' })
  api.getConfig.mockResolvedValue({ serverTicket: null, serverNodeId: null, relayUrl: null })
  api.getConnectionStatus.mockResolvedValue({ state: 'connected' })
  api.listSessions.mockResolvedValue([session])
  api.getActiveSession.mockResolvedValue({ session, messages: [] })
  api.getNotices.mockResolvedValue([])
  api.onPromptEvent.mockImplementation((_handler: (event: PromptEvent) => void) => () => undefined)
  api.onConnectionStatus.mockReturnValue(() => undefined)
  api.onHistoryChanged.mockReturnValue(() => undefined)
  api.onNotice.mockReturnValue(() => undefined)
})

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<App />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('sidebar focus management', () => {
  it('returns focus to the toggle when the rail collapses', async () => {
    await mount()

    const toggle = container!.querySelector<HTMLButtonElement>('.sidebar-toggle')!
    expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar')

    await act(async () => {
      toggle.click()
    })

    expect(toggle.getAttribute('aria-label')).toBe('Expand sidebar')
    expect(document.activeElement).toBe(toggle)
  })
})

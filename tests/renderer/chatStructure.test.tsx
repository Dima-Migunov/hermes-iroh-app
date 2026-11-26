import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptEvent, SessionSnapshot, SessionSummary } from '@shared/protocol'
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
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.8.0') }))

function snapshot(): SessionSnapshot {
  return { session, messages: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getIdentity.mockResolvedValue({ nodeId: 'client-node' })
  api.getConfig.mockResolvedValue({ serverTicket: null, serverNodeId: null, relayUrl: null })
  api.getConnectionStatus.mockResolvedValue({ state: 'connected' })
  api.listSessions.mockResolvedValue([session])
  api.getActiveSession.mockResolvedValue(snapshot())
  api.getNotices.mockResolvedValue([])
  api.onPromptEvent.mockImplementation((_handler: (event: PromptEvent) => void) => () => undefined)
  api.onConnectionStatus.mockReturnValue(() => undefined)
  api.onHistoryChanged.mockReturnValue(() => undefined)
  api.onNotice.mockReturnValue(() => undefined)
})

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mount(): Promise<HTMLDivElement> {
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
  return container
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('chat view structure', () => {
  it('renders exactly one transcript container', async () => {
    const element = await mount()

    const transcripts = element.querySelectorAll('.transcript')
    expect(transcripts.length, 'a second transcript means one scroll container is orphaned').toBe(1)
  })

  it('renders exactly one composer', async () => {
    const element = await mount()

    expect(element.querySelectorAll('.composer').length).toBe(1)
  })

  it('shows the empty state in the single transcript instead of alongside a second one', async () => {
    const element = await mount()

    const transcripts = element.querySelectorAll('.transcript')
    expect(transcripts.length).toBe(1)
    expect(transcripts[0]?.querySelectorAll('.empty-state').length).toBe(1)
    expect(element.querySelectorAll('.message-list').length).toBe(0)
  })
})

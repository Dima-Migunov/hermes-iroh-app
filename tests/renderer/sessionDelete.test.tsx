import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionDeletionResult, SessionSummary } from '@shared/protocol'
import { SessionList } from '@renderer/components/SessionList'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const sessionA: SessionSummary = {
  id: 'session-a',
  title: 'Session A',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
}

const sessionB: SessionSummary = {
  id: 'session-b',
  title: 'Session B',
  createdAt: '2026-01-01T00:00:02.000Z',
  updatedAt: '2026-01-01T00:00:02.000Z',
}

const fallback: SessionSummary = {
  id: 'session-new',
  title: 'New chat',
  createdAt: '2026-01-01T00:00:03.000Z',
  updatedAt: '2026-01-01T00:00:03.000Z',
}

let root: Root | null = null
let container: HTMLDivElement | null = null

interface RenderOptions {
  sessions?: SessionSummary[]
  activeSessionId?: string | null
  onDelete?: (id: string) => Promise<SessionDeletionResult | null>
}

async function render(options: RenderOptions = {}): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <SessionList
        sessions={options.sessions ?? [sessionA, sessionB]}
        activeSessionId={options.activeSessionId ?? 'session-a'}
        disabled={false}
        onCreate={() => undefined}
        onSelect={() => undefined}
        onRename={async () => true}
        onDelete={options.onDelete ?? (async () => null)}
      />,
    )
  })
}

function element<T extends Element>(selector: string): T {
  const found = container?.querySelector<T>(selector)
  if (!found) throw new Error(`Missing element: ${selector}`)
  return found
}

function rows(): HTMLLIElement[] {
  return [...(container?.querySelectorAll<HTMLLIElement>('.session-row') ?? [])]
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function openDelete(): Promise<void> {
  await click(element('.session-actions-trigger'))
  await click(element('[aria-label="Delete session"]'))
}

function deletionResult(
  sessions: SessionSummary[],
  active: SessionSummary,
): SessionDeletionResult {
  return { sessions, activeSession: { session: active, messages: [] } }
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('session delete confirmation', () => {
  it('asks for confirmation, focuses Cancel, and leaves the data untouched', async () => {
    const onDelete = vi.fn(async () => deletionResult([sessionB], sessionB))
    await render({ onDelete })

    await openDelete()

    expect(element('.session-delete-question').textContent).toBe('Delete this session?')
    expect(document.activeElement).toBe(element('.session-delete-cancel'))
    expect(rows()).toHaveLength(2)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('cancels the confirmation on Escape without deleting', async () => {
    const onDelete = vi.fn(async () => deletionResult([sessionB], sessionB))
    await render({ onDelete })

    await openDelete()
    await act(async () => {
      element('.session-delete-confirm').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })

    expect(container?.querySelector('.session-delete-confirm')).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('cancels the confirmation, restores the row, and focuses the trigger', async () => {
    const onDelete = vi.fn(async () => deletionResult([sessionB], sessionB))
    await render({ onDelete })

    await openDelete()
    await click(element('.session-delete-cancel'))

    expect(container?.querySelector('.session-delete-confirm')).toBeNull()
    expect(rows()).toHaveLength(2)
    expect(onDelete).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(element('.session-actions-trigger'))
  })

  it('deletes the active session, removes its row, and focuses the new active row', async () => {
    const onDelete = vi.fn(async () => deletionResult([sessionB], sessionB))
    await render({ onDelete })

    await openDelete()
    await click(element('.session-delete-confirm-button'))
    await render({ sessions: [sessionB], activeSessionId: 'session-b', onDelete })

    expect(onDelete).toHaveBeenCalledWith('session-a')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.querySelector('.session-title')?.textContent).toBe('Session B')
    expect(document.activeElement).toBe(rows()[0]?.querySelector('.session-button'))
  })

  it('deletes an inactive session without changing focus to it', async () => {
    const onDelete = vi.fn(async () => deletionResult([sessionB], sessionB))
    await render({ activeSessionId: 'session-b', onDelete })

    await click(rows()[0]!.querySelector('.session-actions-trigger')!)
    await click(element('[aria-label="Delete session"]'))
    await click(element('.session-delete-confirm-button'))
    await render({ sessions: [sessionB], activeSessionId: 'session-b', onDelete })

    expect(onDelete).toHaveBeenCalledWith('session-a')
    expect(rows()).toHaveLength(1)
    expect(document.activeElement).toBe(rows()[0]?.querySelector('.session-button'))
  })

  it('creates and focuses an empty fallback when the last session is deleted', async () => {
    const onDelete = vi.fn(async () => deletionResult([fallback], fallback))
    await render({ sessions: [sessionA], activeSessionId: 'session-a', onDelete })

    await openDelete()
    await click(element('.session-delete-confirm-button'))
    await render({ sessions: [fallback], activeSessionId: 'session-new', onDelete })

    expect(onDelete).toHaveBeenCalledWith('session-a')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.querySelector('.session-title')?.textContent).toBe('New chat')
    expect(document.activeElement).toBe(rows()[0]?.querySelector('.session-button'))
  })

  it('keeps the row and active session when the deletion fails', async () => {
    const onDelete = vi.fn(async () => null)
    await render({ onDelete })

    await openDelete()
    await click(element('.session-delete-confirm-button'))

    expect(onDelete).toHaveBeenCalledWith('session-a')
    expect(container?.querySelector('.session-delete-confirm')).toBeNull()
    expect(rows()).toHaveLength(2)
    expect(rows()[0]?.querySelector('.session-button--active')).not.toBeNull()
    expect(document.activeElement).toBe(rows()[0]?.querySelector('.session-actions-trigger'))
  })
})

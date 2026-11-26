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

let root: Root | null = null
let container: HTMLDivElement | null = null

interface RenderOptions {
  sessions?: SessionSummary[]
  onRename?: (id: string, title: string) => Promise<boolean>
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
        activeSessionId="session-a"
        disabled={false}
        onCreate={() => undefined}
        onSelect={() => undefined}
        onRename={options.onRename ?? (async () => true)}
        onDelete={async (): Promise<SessionDeletionResult | null> => null}
      />,
    )
  })
}

function element<T extends Element>(selector: string): T {
  const found = container?.querySelector<T>(selector)
  if (!found) throw new Error(`Missing element: ${selector}`)
  return found
}

function query<T extends Element>(selector: string): T | null {
  return container?.querySelector<T>(selector) ?? null
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function openRename(): Promise<HTMLInputElement> {
  await click(element('.session-actions-trigger'))
  await click(element('[aria-label="Rename session"]'))
  return element<HTMLInputElement>('.session-rename-input')
}

async function setValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('Missing input value setter')
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(input: HTMLInputElement): Promise<void> {
  const form = input.closest('form')
  if (!form) throw new Error('Missing rename form')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
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

describe('session rename editor', () => {
  it('prefills, selects, trims, and commits the new title', async () => {
    const onRename = vi.fn(async () => true)
    await render({ onRename })

    const input = await openRename()
    expect(input.value).toBe('Session A')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Session A'.length)
    expect(input.maxLength).toBe(60)

    await setValue(input, '  Renamed session  ')
    await submit(input)

    expect(onRename).toHaveBeenCalledWith('session-a', 'Renamed session')
    expect(query('.session-rename')).toBeNull()
    expect(document.activeElement).toBe(element('.session-actions-trigger'))
  })

  it('shows an inline validation message and keeps the editor open for an empty title', async () => {
    const onRename = vi.fn(async () => true)
    await render({ onRename })

    const input = await openRename()
    await setValue(input, '   ')
    await submit(input)

    expect(onRename).not.toHaveBeenCalled()
    expect(query('.session-rename')).not.toBeNull()
    expect(element('.session-rename-error').textContent).toBe('A title is required.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('rename-error-session-a')
  })

  it('cancels on Escape and restores focus to the trigger without saving', async () => {
    const onRename = vi.fn(async () => true)
    await render({ onRename })

    const input = await openRename()
    await setValue(input, 'Discarded title')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onRename).not.toHaveBeenCalled()
    expect(query('.session-rename')).toBeNull()
    expect(document.activeElement).toBe(element('.session-actions-trigger'))
    expect(element('.session-title').textContent).toBe('Session A')
  })

  it('closes on a failed save, keeps the previous title, and refocuses the trigger', async () => {
    const onRename = vi.fn(async () => false)
    await render({ onRename })

    const input = await openRename()
    await setValue(input, 'Renamed session')
    await submit(input)

    expect(onRename).toHaveBeenCalledWith('session-a', 'Renamed session')
    expect(query('.session-rename')).toBeNull()
    expect(element('.session-title').textContent).toBe('Session A')
    expect(document.activeElement).toBe(element('.session-actions-trigger'))
  })

  it('renders the updated title immediately after the parent applies the rename', async () => {
    const renamed: SessionSummary = { ...sessionA, title: 'Renamed session', customTitle: true }
    await render({ sessions: [renamed, sessionB] })

    expect(element('.session-title').textContent).toBe('Renamed session')
  })
})

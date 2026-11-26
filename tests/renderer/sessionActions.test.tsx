import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function element<T extends Element>(selector: string): T {
  const found = container?.querySelector<T>(selector)
  if (!found) throw new Error(`Missing element: ${selector}`)
  return found
}

function rows(): HTMLLIElement[] {
  return [...(container?.querySelectorAll<HTMLLIElement>('.session-row') ?? [])]
}

function actionAreas(): HTMLDivElement[] {
  return [...(container?.querySelectorAll<HTMLDivElement>('.session-actions') ?? [])]
}

async function render(
  overrides: {
    sessions?: SessionSummary[]
    activeSessionId?: string | null
    disabled?: boolean
  } = {},
): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <SessionList
        sessions={overrides.sessions ?? [sessionA, sessionB]}
        activeSessionId={overrides.activeSessionId ?? 'session-a'}
        disabled={overrides.disabled ?? false}
        onCreate={() => undefined}
        onSelect={() => undefined}
        onRename={async () => true}
        onDelete={async (): Promise<SessionDeletionResult | null> => null}
      />,
    )
  })
}

function pointerEvent(type: string, pointerType: string): Event {
  const EventType = window.PointerEvent ?? window.MouseEvent
  const event = new EventType(type, { bubbles: true, relatedTarget: document.body })
  Object.defineProperty(event, 'pointerType', { value: pointerType, configurable: true })
  return event
}

async function pointerEnter(target: Element, pointerType = 'mouse'): Promise<void> {
  await act(async () => {
    target.dispatchEvent(pointerEvent('pointerover', pointerType))
  })
}

async function pointerLeave(target: Element, pointerType = 'mouse'): Promise<void> {
  await act(async () => {
    target.dispatchEvent(pointerEvent('pointerout', pointerType))
  })
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function press(target: Element, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function openCount(): number {
  return container?.querySelectorAll('.session-actions--open').length ?? 0
}

beforeEach(async () => {
  vi.clearAllMocks()
  await render()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('session action reveal', () => {
  it('reveals the actions on a mouse pointer enter and restores the trigger on leave', async () => {
    const area = actionAreas()[0]!
    expect(openCount()).toBe(0)

    await pointerEnter(area)
    expect(openCount()).toBe(1)

    await pointerLeave(area)
    expect(openCount()).toBe(0)
  })

  it('ignores emulated hover on touch and toggles with taps', async () => {
    const area = actionAreas()[0]!
    await pointerEnter(area, 'touch')
    expect(openCount()).toBe(0)

    const trigger = area.querySelector<HTMLButtonElement>('.session-actions-trigger')!
    await click(trigger)
    expect(openCount()).toBe(1)

    await click(trigger)
    expect(openCount()).toBe(0)
  })

  it('closes when a pointer down lands outside the row', async () => {
    await pointerEnter(actionAreas()[0]!)
    expect(openCount()).toBe(1)

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })

    expect(openCount()).toBe(0)
  })

  it('keeps the actions open while focus remains inside the row', async () => {
    await pointerEnter(actionAreas()[0]!)
    const rename = element<HTMLButtonElement>('[aria-label="Rename session"]')
    await act(async () => rename.focus())

    await pointerLeave(actionAreas()[0]!)
    expect(openCount()).toBe(1)
  })

  it('opens on keyboard focus, closes on Escape, and restores focus to the trigger', async () => {
    const trigger = element<HTMLButtonElement>('.session-actions-trigger')
    await act(async () => trigger.focus())

    expect(openCount()).toBe(1)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    await press(trigger, 'Escape')

    expect(openCount()).toBe(0)
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps only one row open at a time', async () => {
    const triggers = [
      ...container!.querySelectorAll<HTMLButtonElement>('.session-actions-trigger'),
    ]

    await click(triggers[0]!)
    expect(openCount()).toBe(1)
    await click(triggers[1]!)

    expect(openCount()).toBe(1)
    expect(rows()[1]!.querySelector('.session-actions--open')).not.toBeNull()
  })

  it('keeps both rename and delete reachable with accessible names', async () => {
    await pointerEnter(actionAreas()[0]!)

    expect(element('[aria-label="Rename session"]')).toBeTruthy()
    expect(element('[aria-label="Delete session"]')).toBeTruthy()
    expect(element('[aria-label="Session actions"]')).toBeTruthy()
  })
})

describe('disabled session actions', () => {
  it('closes an open row when generation disables the actions', async () => {
    await click(element('.session-actions-trigger'))
    expect(openCount()).toBe(1)

    await render({ disabled: true })

    expect(openCount()).toBe(0)
  })

  it('does not open and disables every action while generating', async () => {
    await render({ disabled: true })

    const trigger = element<HTMLButtonElement>('.session-actions-trigger')
    expect(trigger.disabled).toBe(true)
    await act(async () => trigger.focus())
    await pointerEnter(actionAreas()[0]!)

    expect(openCount()).toBe(0)
    expect(element<HTMLButtonElement>('[aria-label="Rename session"]').disabled).toBe(true)
    expect(element<HTMLButtonElement>('[aria-label="Delete session"]').disabled).toBe(true)
  })
})

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredMessage } from '@shared/protocol'
import { Transcript } from '@renderer/components/Transcript'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const noop = async (): Promise<void> => undefined

function messages(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${index}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'complete' as const,
  }))
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let scheduled: FrameRequestCallback[] = []

beforeEach(() => {
  scheduled = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    scheduled.push(callback)
    return scheduled.length
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    scheduled[handle - 1] = () => undefined
  })
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

function mount(value: StoredMessage[]): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<Transcript messages={value} generating={false} onCopy={noop} />)
  })
}

function runFrames(): void {
  const pending = scheduled
  scheduled = []
  act(() => {
    for (const callback of pending) callback(0)
  })
}

describe('Transcript scroll coalescing', () => {
  it('schedules one animation frame per update instead of scrolling synchronously', () => {
    mount(messages(2))
    expect(scheduled.length).toBeGreaterThan(0)
  })

  it('keeps the view pinned to the bottom when already at the bottom', () => {
    mount(messages(2))
    const scroller = container!.querySelector<HTMLDivElement>('.transcript')!
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true })
    scroller.scrollTop = 600

    runFrames()
    expect(scroller.scrollTop).toBe(1000)
  })

  it('does not jump to the bottom when the user scrolled away', () => {
    mount(messages(2))
    const scroller = container!.querySelector<HTMLDivElement>('.transcript')!
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true })
    scroller.scrollTop = 100

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    runFrames()
    expect(scroller.scrollTop).toBe(100)
  })
})

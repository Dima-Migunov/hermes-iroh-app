import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredMessage } from '@shared/protocol'
import { Transcript } from '@renderer/components/Transcript'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const noop = async (): Promise<void> => undefined
const SESSION = 'session-a'

function message(
  id: string,
  content: string,
  role: 'user' | 'assistant' = 'assistant',
): StoredMessage {
  return {
    id,
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
  }
}

function messages(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_value, index) => message(`message-${index}`, `message ${index}`))
}

interface RenderOptions {
  messages: StoredMessage[]
  sessionId?: string | null
  strict?: boolean
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let scroller: HTMLDivElement | null = null
let scheduled = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let scrollToSpy: ReturnType<typeof vi.fn>
let resizeCallbacks: Array<() => void>
let observedTargets: Element[]
let reducedMotion: boolean

function setMetrics(element: HTMLDivElement, scrollHeight: number, clientHeight: number, top: number): void {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(element, 'scrollTop', { value: top, writable: true, configurable: true })
}

function render({ messages: value, sessionId = SESSION, strict = false }: RenderOptions): void {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  const transcript = (
    <Transcript messages={value} generating={false} sessionId={sessionId} onCopy={noop} />
  )
  act(() => {
    root?.render(strict ? <StrictMode>{transcript}</StrictMode> : transcript)
  })
  const next = container!.querySelector<HTMLDivElement>('.transcript')
  if (next && next !== scroller) {
    Object.defineProperty(next, 'scrollTo', { value: scrollToSpy, configurable: true })
    scroller = next
  }
}

function pendingFrames(): number {
  return scheduled.size
}

function runFrames(limit = 500): void {
  let batches = 0
  while (scheduled.size > 0 && batches++ < limit) {
    const batch = [...scheduled.values()]
    scheduled.clear()
    act(() => {
      for (const callback of batch) callback(0)
    })
  }
}

function runOneFrame(): void {
  const entry = scheduled.entries().next().value
  if (!entry) return
  scheduled.delete(entry[0])
  act(() => entry[1](0))
}

function setPosition(top: number, scrollHeight = 1000, clientHeight = 400): void {
  setMetrics(scroller!, scrollHeight, clientHeight, top)
}

function scrollToPosition(top: number, gesture?: 'wheel' | 'touch'): void {
  setPosition(top)
  act(() => {
    if (gesture === 'wheel') scroller!.dispatchEvent(new Event('wheel'))
    if (gesture === 'touch') scroller!.dispatchEvent(new Event('touchstart'))
    scroller!.dispatchEvent(new Event('scroll'))
  })
}

function settleAtBottom(scrollHeight = 1000, clientHeight = 400): void {
  setPosition(scrollHeight - clientHeight, scrollHeight, clientHeight)
  runFrames()
}

function scrollAway(): void {
  scrollToPosition(100, 'wheel')
}

function scrollbarAway(): void {
  scrollToPosition(100)
}

function newMessagesButton(): HTMLButtonElement | null {
  return container!.querySelector<HTMLButtonElement>('.new-messages-button')
}

beforeEach(() => {
  scheduled = new Map()
  nextFrameId = 1
  resizeCallbacks = []
  observedTargets = []
  reducedMotion = false
  scrollToSpy = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    scheduled.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    scheduled.delete(id)
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
      }
      observe(target: Element): void {
        observedTargets.push(target)
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' ? reducedMotion : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  scroller = null
  vi.unstubAllGlobals()
})

describe('transcript scroll target and coalescing', () => {
  it('coalesces multiple updates into one frame and targets scrollHeight - clientHeight', () => {
    render({ messages: messages(2) })
    expect(pendingFrames()).toBe(1)

    render({ messages: messages(3) })
    render({ messages: messages(4) })
    expect(pendingFrames()).toBe(1)

    setPosition(0)
    runFrames()
    expect(scroller!.scrollTop).toBe(600)
  })

  it('keeps the view pinned as streamed content grows', () => {
    render({ messages: [message('a', 'a')] })
    setPosition(600)
    runFrames()
    expect(scroller!.scrollTop).toBe(600)
    expect(newMessagesButton()).toBeNull()

    render({ messages: [message('a', 'ab')] })
    setPosition(600, 1200)
    runFrames()
    expect(scroller!.scrollTop).toBe(800)
    expect(newMessagesButton()).toBeNull()
  })
})

describe('reading history', () => {
  it('preserves the position when the user scrolls with the scrollbar', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollbarAway()
    runFrames()

    expect(scroller!.scrollTop).toBe(100)

    render({ messages: messages(3) })
    expect(newMessagesButton()).not.toBeNull()
  })

  it('preserves the position through a touch drag that starts near the bottom', () => {
    render({ messages: messages(2) })
    settleAtBottom()

    scrollToPosition(580, 'touch')
    scrollToPosition(300)
    runFrames()

    expect(scroller!.scrollTop).toBe(300)
  })

  it('does not follow new content while reading history', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()

    render({ messages: messages(3) })
    setPosition(100)
    runFrames()
    expect(scroller!.scrollTop).toBe(100)
  })

  it('counts newly added messages rather than streamed deltas', () => {
    render({ messages: [message('a', 'a')] })
    settleAtBottom()
    scrollAway()

    render({ messages: [message('a', 'a'), message('b', '')] })
    expect(newMessagesButton()?.getAttribute('aria-label')).toBe('New messages, 1 new')

    render({ messages: [message('a', 'a'), message('b', 'b')] })
    render({ messages: [message('a', 'a'), message('b', 'bc')] })
    expect(newMessagesButton()?.getAttribute('aria-label')).toBe('New messages, 1 new')

    render({ messages: [message('a', 'a'), message('b', 'bc'), message('c', 'c')] })
    expect(newMessagesButton()?.getAttribute('aria-label')).toBe('New messages, 2 new')
  })

  it('shows the indicator without a count when an existing message grows', () => {
    render({ messages: [message('a', 'a')] })
    settleAtBottom()
    scrollAway()

    render({ messages: [message('a', 'ab')] })
    expect(newMessagesButton()).not.toBeNull()
    expect(newMessagesButton()?.getAttribute('aria-label')).toBe('New messages')
    expect(newMessagesButton()?.querySelector('.new-messages-count')).toBeNull()
  })

  it('clears the indicator when the user scrolls back within the threshold', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })
    expect(newMessagesButton()).not.toBeNull()

    setPosition(580)
    act(() => {
      scroller!.dispatchEvent(new Event('scroll'))
    })
    expect(newMessagesButton()).toBeNull()
  })
})

describe('returning to the latest content', () => {
  it('starts a smooth return and holds the guard while it is in flight', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })

    act(() => {
      newMessagesButton()?.click()
    })
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 600, behavior: 'smooth' })
    expect(newMessagesButton()).toBeNull()

    setPosition(100)
    runOneFrame()
    expect(scroller!.scrollTop).toBe(100)

    setPosition(100, 1200)
    act(() => {
      scroller!.dispatchEvent(new Event('scrollend'))
    })
    expect(scroller!.scrollTop).toBe(800)
  })

  it('keeps the own-submission return smooth instead of scheduling a follow frame', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()

    setPosition(100)
    render({ messages: [...messages(2), message('own', 'hello', 'user')] })
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 600, behavior: 'smooth' })

    runOneFrame()
    expect(scroller!.scrollTop).toBe(100)

    setPosition(100, 1200)
    act(() => {
      scroller!.dispatchEvent(new Event('scrollend'))
    })
    expect(scroller!.scrollTop).toBe(800)
  })

  it('lets a wheel gesture cancel an in-flight smooth return', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })

    act(() => {
      newMessagesButton()?.click()
    })
    scrollToPosition(100, 'wheel')
    runFrames()

    expect(scroller!.scrollTop).toBe(100)
  })

  it('lets a wheel gesture win immediately after a return settles', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })

    act(() => {
      newMessagesButton()?.click()
    })
    act(() => {
      scroller!.dispatchEvent(new Event('scrollend'))
    })
    runFrames()
    expect(scroller!.scrollTop).toBe(600)

    scrollToPosition(100, 'wheel')
    runFrames()
    expect(scroller!.scrollTop).toBe(100)
  })

  it('does not lock scrolling after submitting while already at the bottom', () => {
    render({ messages: messages(2) })
    settleAtBottom()

    render({ messages: [...messages(2), message('own', 'hello', 'user')] })
    expect(scrollToSpy).not.toHaveBeenCalled()

    scrollToPosition(100, 'wheel')
    runFrames()
    expect(scroller!.scrollTop).toBe(100)
  })

  it('returns immediately under reduced motion and stays interruptible', () => {
    reducedMotion = true
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })

    act(() => {
      newMessagesButton()?.click()
    })
    expect(scroller!.scrollTop).toBe(600)

    scrollToPosition(100, 'wheel')
    runFrames()
    expect(scroller!.scrollTop).toBe(100)
  })

  it('does not release the return guard while a smooth scroll is still moving', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })

    act(() => {
      newMessagesButton()?.click()
    })

    for (let frame = 0; frame < 32; frame += 1) {
      setPosition(100 + frame)
      runOneFrame()
    }
    expect(scroller!.scrollTop).toBe(131)
  })
})

describe('session switching and resize', () => {
  it('resets the indicator and opens a switched session at the end', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })
    expect(newMessagesButton()).not.toBeNull()

    setPosition(0)
    render({ messages: messages(4), sessionId: 'session-b' })

    expect(newMessagesButton()).toBeNull()
    expect(scroller!.scrollTop).toBe(600)
  })

  it('follows resizes while following and observes both nodes', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    expect(observedTargets).toContain(scroller)
    expect(observedTargets).toContain(container!.querySelector('.transcript-content'))

    act(() => {
      for (const callback of resizeCallbacks) callback()
    })
    expect(pendingFrames()).toBe(1)
    setPosition(600, 900)
    runFrames()
    expect(scroller!.scrollTop).toBe(500)
  })

  it('does not follow resizes while reading history', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()

    act(() => {
      for (const callback of resizeCallbacks) callback()
    })
    expect(pendingFrames()).toBe(0)
    expect(scroller!.scrollTop).toBe(100)
  })

  it('resumes following when a resize brings the view within the threshold', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })
    expect(newMessagesButton()).not.toBeNull()

    setPosition(100, 500)
    act(() => {
      for (const callback of resizeCallbacks) callback()
    })
    runFrames()
    expect(newMessagesButton()).toBeNull()

    render({ messages: messages(4) })
    setPosition(100, 600)
    runFrames()
    expect(scroller!.scrollTop).toBe(200)
  })

  it('falls back to window resize when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    render({ messages: messages(2) })
    settleAtBottom()

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(pendingFrames()).toBe(1)
    setPosition(600, 900)
    runFrames()
    expect(scroller!.scrollTop).toBe(500)
  })
})

describe('strict mode and accessibility', () => {
  it('keeps following across StrictMode effect cleanup', () => {
    render({ messages: messages(2), strict: true })
    settleAtBottom()

    render({ messages: messages(3), strict: true })
    setPosition(600, 1200)
    runFrames()

    expect(scroller!.scrollTop).toBe(800)
  })

  it('moves focus to the transcript when the control is activated', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })

    const button = newMessagesButton()!
    act(() => {
      button.focus()
      button.click()
    })

    expect(document.activeElement).toBe(scroller)
  })

  it('keeps the visible label in the accessible name', () => {
    render({ messages: messages(2) })
    settleAtBottom()
    scrollAway()
    render({ messages: messages(3) })

    const label = newMessagesButton()?.getAttribute('aria-label')
    expect(label).toContain('New messages')
    expect(label).toContain('1')
  })
})

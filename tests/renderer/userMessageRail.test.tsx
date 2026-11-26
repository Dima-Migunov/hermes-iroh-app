import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredMessage } from '@shared/protocol'
import { Transcript } from '@renderer/components/Transcript'
import { UserMessageRail, type RailMarker } from '@renderer/components/UserMessageRail'
import {
  RAIL_BOTTOM_INSET_PX,
  RAIL_MARKER_HEIGHT_PX,
  RAIL_TOP_INSET_PX,
} from '@renderer/transcriptGeometry'

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

let root: Root | null = null
let container: HTMLDivElement | null = null
let scroller: HTMLDivElement | null = null
let scheduled = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let scrollToSpy: ReturnType<typeof vi.fn>
let resizeCallbacks: Array<() => void>
let observedTargets: Element[]
let reducedMotion: boolean

function setMetrics(
  element: HTMLDivElement,
  scrollHeight: number,
  clientHeight: number,
  top: number,
): void {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(element, 'scrollTop', { value: top, writable: true, configurable: true })
}

function mount(element: ReactElement): void {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  act(() => {
    root?.render(element)
  })
  const next = container!.querySelector<HTMLDivElement>('.transcript')
  if (next && next !== scroller) {
    Object.defineProperty(next, 'scrollTo', { value: scrollToSpy, configurable: true })
    scroller = next
  }
}

function render(messages: StoredMessage[], sessionId = SESSION): void {
  mount(<Transcript messages={messages} generating={false} sessionId={sessionId} onCopy={noop} />)
}

const MARKERS: RailMarker[] = [
  {
    id: 'm1',
    ordinal: 1,
    preview: 'first question',
    text: 'first question with full detail',
    top: 10,
  },
  { id: 'm2', ordinal: 2, preview: 'second question', text: 'second question', top: 790 },
]

interface RailOptions {
  markers?: RailMarker[]
  railRight?: number
  railHeight?: number
  onJump?: (id: string) => void
}

function renderRail(options: RailOptions = {}): (id: string) => void {
  const onJump: (id: string) => void = options.onJump ?? vi.fn()
  mount(
    <div className="transcript-shell">
      <UserMessageRail
        markers={options.markers ?? MARKERS}
        railRight={options.railRight ?? 6}
        railHeight={options.railHeight ?? 400}
        onJump={onJump}
      />
    </div>,
  )
  return onJump
}

function markerButtons(): HTMLButtonElement[] {
  return [...container!.querySelectorAll<HTMLButtonElement>('.user-message-rail__marker')]
}

function markerButton(index: number): HTMLButtonElement {
  const button = markerButtons()[index]
  if (!button) throw new Error(`missing marker button ${index}`)
  return button
}

function tooltip(): HTMLElement | null {
  return container!.querySelector<HTMLElement>('.user-message-rail__tooltip')
}

function pointerOver(target: Element, pointerType = 'mouse'): void {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }))
  })
}

function pointerOut(target: Element, pointerType = 'mouse'): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent('pointerout', {
        bubbles: true,
        pointerType,
        relatedTarget: document.body,
      }),
    )
  })
}

function keyboardFocus(target: HTMLElement): void {
  act(() => {
    container!.querySelector('.user-message-rail')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    )
  })
  act(() => {
    target.focus()
  })
}

function rail(): HTMLElement | null {
  return container!.querySelector<HTMLElement>('.user-message-rail')
}

function railTops(): number[] {
  return markerButtons().map((button) => Number.parseFloat(button.style.top))
}

function rectAt(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function placeAnchor(id: string, top: number): void {
  const item = container!.querySelector(`.message-list > li[data-message-id="${id}"]`)
  if (!item) throw new Error(`missing message anchor ${id}`)
  Object.defineProperty(item, 'getBoundingClientRect', {
    value: () => rectAt(top, 40),
    configurable: true,
  })
}

function fireResize(): void {
  act(() => {
    for (const callback of resizeCallbacks) callback()
  })
}

function stubFocusVisible(value: boolean): void {
  const original = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ): boolean {
    if (selector === ':focus-visible') return value
    return original.call(this, selector)
  })
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('message anchors', () => {
  it('anchors every rendered message with its own id', () => {
    render([message('user-1', 'hello', 'user'), message('assistant-1', 'hi')])

    const items = [...container!.querySelectorAll('.message-list > li')]

    expect(items.map((item) => item.getAttribute('data-message-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
  })
})

describe('user message rail', () => {
  it('renders a labelled navigation with one named button per marker', () => {
    renderRail()

    expect(container!.querySelector('nav')?.getAttribute('aria-label')).toBe('Your messages')
    expect(markerButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Your message 1 of 2: first question',
      'Your message 2 of 2: second question',
    ])
    expect(markerButtons().every((button) => button.type === 'button')).toBe(true)
  })

  it('renders nothing when there are no markers', () => {
    renderRail({ markers: [] })

    expect(container!.querySelector('.user-message-rail')).toBeNull()
  })

  it('shows only the user message text on pointer hover', () => {
    renderRail()

    pointerOver(markerButton(0))

    expect(tooltip()?.textContent).toBe('first question with full detail')
    expect(tooltip()?.textContent).not.toContain('assistant')
    expect(tooltip()?.getAttribute('aria-hidden')).toBe('true')
  })

  it('hides the tooltip when the pointer leaves', () => {
    renderRail()

    pointerOver(markerButton(0))
    pointerOut(markerButton(0))

    expect(tooltip()).toBeNull()
  })

  it('opens the tooltip on keyboard focus and closes it on blur', () => {
    renderRail()

    keyboardFocus(markerButton(1))
    expect(tooltip()?.textContent).toBe('second question')

    act(() => {
      markerButton(1).blur()
    })
    expect(tooltip()).toBeNull()
  })

  it('opens the tooltip for browser-reported keyboard focus without a keydown', () => {
    stubFocusVisible(true)
    renderRail()

    act(() => {
      markerButton(0).focus()
    })

    expect(tooltip()?.textContent).toBe('first question with full detail')
  })

  it('keeps the tooltip closed for pointer focus that is not focus-visible', () => {
    stubFocusVisible(false)
    renderRail()

    act(() => {
      markerButton(0).focus()
    })

    expect(tooltip()).toBeNull()
  })

  it('jumps when a marker is clicked', () => {
    const onJump = renderRail()

    act(() => {
      markerButton(0).click()
    })

    expect(onJump).toHaveBeenCalledWith('m1')
  })

  it('jumps on touch without leaving a sticky tooltip', () => {
    const onJump = renderRail()
    const button = markerButton(1)

    act(() => {
      button.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
      )
    })
    pointerOver(button, 'touch')
    act(() => {
      button.click()
    })

    expect(onJump).toHaveBeenCalledWith('m2')
    expect(tooltip()).toBeNull()
  })

  it('keeps the tooltip inside the shell vertically', () => {
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
    renderRail()

    pointerOver(markerButton(0))
    expect(tooltip()?.style.top).toBe('12px')

    pointerOut(markerButton(0))
    pointerOver(markerButton(1))
    expect(tooltip()?.style.top).toBe('688px')
  })
})

describe('rail data', () => {
  it('shows no rail for an empty transcript', () => {
    render([])
    runFrames()

    expect(rail()).toBeNull()
  })

  it('shows no rail when only assistant messages overflow', () => {
    render([message('assistant-1', 'a'.repeat(4000)), message('assistant-2', 'more')])
    setMetrics(scroller!, 2000, 400, 0)
    runFrames()

    expect(rail()).toBeNull()
  })

  it('shows no rail when the transcript fits', () => {
    render([message('user-1', 'hello', 'user')])
    setMetrics(scroller!, 300, 400, 0)
    runFrames()

    expect(rail()).toBeNull()
  })

  it('places one marker per user message at proportional, separated positions', () => {
    render([
      message('user-1', 'first', 'user'),
      message('assistant-1', 'reply'),
      message('user-2', 'second', 'user'),
      message('user-3', 'third', 'user'),
    ])
    placeAnchor('user-1', 0)
    placeAnchor('user-2', 300)
    placeAnchor('user-3', 900)
    setMetrics(scroller!, 1000, 400, 0)
    runFrames()

    expect(markerButtons()).toHaveLength(3)
    expect(markerButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Your message 1 of 3: first',
      'Your message 2 of 3: second',
      'Your message 3 of 3: third',
    ])
    const [first, second, third] = railTops()
    const usable = 400 - RAIL_MARKER_HEIGHT_PX - RAIL_TOP_INSET_PX - RAIL_BOTTOM_INSET_PX
    expect(first).toBe(RAIL_TOP_INSET_PX)
    expect(second).toBeCloseTo(RAIL_TOP_INSET_PX + (284 / 600) * usable, 3)
    expect(third).toBe(RAIL_TOP_INSET_PX + usable)
    expect(third! + RAIL_MARKER_HEIGHT_PX).toBe(400 - RAIL_BOTTOM_INSET_PX)
    expect(second! - first!).toBeGreaterThanOrEqual(6)
    expect(third! - second!).toBeGreaterThanOrEqual(6)
    expect(rail()!.style.height).toBe('400px')
    expect(rail()!.style.right).toBe('16px')
  })

  it('keeps the rail clear of overlay scrollbars and classic scrollbars', () => {
    render([message('user-1', 'first', 'user')])
    placeAnchor('user-1', 0)
    setMetrics(scroller!, 1000, 400, 0)
    Object.defineProperty(scroller!, 'offsetWidth', { configurable: true, value: 1000 })
    Object.defineProperty(scroller!, 'clientWidth', { configurable: true, value: 1000 })
    runFrames()

    expect(rail()!.style.right).toBe('16px')

    Object.defineProperty(scroller!, 'clientWidth', { configurable: true, value: 980 })
    fireResize()
    runFrames()

    expect(rail()!.style.right).toBe('24px')
  })

  it('keeps a dense rail inside both safety insets', () => {
    const dense = Array.from({ length: 45 }, (_, index) =>
      message(`user-${index}`, `message ${index}`, 'user'),
    )
    render(dense)
    dense.forEach((entry) => placeAnchor(entry.id, 900))
    setMetrics(scroller!, 2000, 400, 0)
    runFrames()

    const tops = railTops()
    expect(tops).toHaveLength(45)
    expect(tops[0]).toBeGreaterThanOrEqual(RAIL_TOP_INSET_PX)
    expect(tops[44]! + RAIL_MARKER_HEIGHT_PX).toBe(400 - RAIL_BOTTOM_INSET_PX)
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index]! - tops[index - 1]!).toBeGreaterThanOrEqual(6)
    }
  })

  it('updates marker positions when the content grows', () => {
    render([message('user-1', 'first', 'user'), message('user-2', 'second', 'user')])
    placeAnchor('user-1', 100)
    placeAnchor('user-2', 400)
    setMetrics(scroller!, 1000, 400, 0)
    runFrames()
    expect(railTops()[1]).toBeCloseTo(RAIL_TOP_INSET_PX + (384 / 600) * 336, 3)

    setMetrics(scroller!, 2000, 400, 0)
    fireResize()
    runFrames()

    expect(railTops()[0]).toBeCloseTo(RAIL_TOP_INSET_PX + (84 / 1600) * 336, 3)
    expect(railTops()[1]).toBeCloseTo(RAIL_TOP_INSET_PX + (384 / 1600) * 336, 3)
  })

  it('updates markers when the transcript resizes', () => {
    render([message('user-1', 'only', 'user')])
    placeAnchor('user-1', 300)
    setMetrics(scroller!, 1000, 400, 0)
    runFrames()
    expect(railTops()[0]).toBeCloseTo(RAIL_TOP_INSET_PX + (284 / 600) * 336, 3)

    setMetrics(scroller!, 1000, 600, 0)
    fireResize()
    runFrames()

    expect(railTops()[0]).toBeCloseTo(RAIL_TOP_INSET_PX + (284 / 400) * 536, 3)
    expect(rail()!.style.height).toBe('600px')
  })

  it('falls back to window resize when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    render([message('user-1', 'only', 'user')])
    placeAnchor('user-1', 300)
    setMetrics(scroller!, 1000, 400, 0)
    runFrames()
    expect(railTops()[0]).toBeCloseTo(RAIL_TOP_INSET_PX + (284 / 600) * 336, 3)

    setMetrics(scroller!, 1000, 600, 0)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    runFrames()

    expect(railTops()[0]).toBeCloseTo(RAIL_TOP_INSET_PX + (284 / 400) * 536, 3)
  })

  it('resets markers when the session changes', () => {
    render([message('user-a', 'alpha', 'user')], 'session-a')
    placeAnchor('user-a', 0)
    setMetrics(scroller!, 1000, 400, 0)
    runFrames()
    expect(markerButtons()[0]?.getAttribute('aria-label')).toBe('Your message 1 of 1: alpha')

    render([message('user-b', 'bravo', 'user')], 'session-b')
    expect(rail()).toBeNull()

    placeAnchor('user-b', 500)
    runFrames()

    expect(markerButtons()).toHaveLength(1)
    expect(markerButtons()[0]?.getAttribute('aria-label')).toBe('Your message 1 of 1: bravo')
  })
})

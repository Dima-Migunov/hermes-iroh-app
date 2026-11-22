import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaQuery } from '@renderer/useMediaQuery'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type ChangeListener = (event: MediaQueryListEvent) => void

class FakeMediaQueryList {
  matches: boolean
  readonly media: string
  private listeners = new Set<ChangeListener>()

  constructor(media: string, matches: boolean) {
    this.media = media
    this.matches = matches
  }

  addEventListener(_type: 'change', listener: ChangeListener): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'change', listener: ChangeListener): void {
    this.listeners.delete(listener)
  }

  setMatches(next: boolean): void {
    this.matches = next
    for (const listener of this.listeners) {
      listener({ matches: next } as MediaQueryListEvent)
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

function Probe({ query }: { query: string }) {
  return <span>{useMediaQuery(query) ? 'compact' : 'wide'}</span>
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderProbe(query = '(max-width: 720px)'): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(<Probe query={query} />))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

describe('useMediaQuery', () => {
  it('reports the initial match state and subscribes to changes', () => {
    const mediaQueryList = new FakeMediaQueryList('(max-width: 720px)', true)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mediaQueryList),
    )

    renderProbe()

    expect(container?.textContent).toBe('compact')
    expect(mediaQueryList.listenerCount).toBe(1)

    act(() => mediaQueryList.setMatches(false))
    expect(container?.textContent).toBe('wide')
  })

  it('unsubscribes when the component unmounts', () => {
    const mediaQueryList = new FakeMediaQueryList('(max-width: 720px)', false)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mediaQueryList),
    )

    renderProbe()
    expect(container?.textContent).toBe('wide')

    act(() => root?.unmount())
    root = null
    expect(mediaQueryList.listenerCount).toBe(0)
  })

  it('falls back to a wide layout when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)

    renderProbe()

    expect(container?.textContent).toBe('wide')
  })

  it('resubscribes when the query changes', () => {
    const first = new FakeMediaQueryList('(max-width: 720px)', true)
    const second = new FakeMediaQueryList('(max-width: 480px)', false)
    const matchMedia = vi.fn((query: string) =>
      query === '(max-width: 720px)' ? first : second,
    )
    vi.stubGlobal('matchMedia', matchMedia)

    renderProbe()
    expect(first.listenerCount).toBe(1)

    act(() => root?.render(<Probe query="(max-width: 480px)" />))

    expect(first.listenerCount).toBe(0)
    expect(second.listenerCount).toBe(1)
    expect(container?.textContent).toBe('wide')
  })
})

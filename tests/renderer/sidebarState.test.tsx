import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useSidebarState, type SidebarState } from '@renderer/useSidebarState'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Probe({ compact, onState }: { compact: boolean; onState: (state: SidebarState) => void }) {
  onState(useSidebarState(compact))
  return null
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let state: SidebarState

function render(compact: boolean): void {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  act(() => root?.render(<Probe compact={compact} onState={(next) => (state = next)} />))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('useSidebarState', () => {
  it('starts expanded on a wide viewport and toggles both ways', () => {
    render(false)
    expect(state.expanded).toBe(true)

    act(() => state.toggle())
    expect(state.expanded).toBe(false)

    act(() => state.toggle())
    expect(state.expanded).toBe(true)
  })

  it('starts collapsed on a compact viewport and opens as a drawer', () => {
    render(true)
    expect(state.expanded).toBe(false)

    act(() => state.toggle())
    expect(state.expanded).toBe(true)

    act(() => state.close())
    expect(state.expanded).toBe(false)
  })

  it('closes the drawer when the viewport becomes compact', () => {
    render(false)
    expect(state.expanded).toBe(true)

    render(true)
    expect(state.expanded).toBe(false)

    act(() => state.toggle())
    expect(state.expanded).toBe(true)

    render(true)
    expect(state.expanded).toBe(true)
  })

  it('restores the last wide preference after returning from a compact viewport', () => {
    render(false)
    act(() => state.toggle())
    expect(state.expanded).toBe(false)

    render(true)
    expect(state.expanded).toBe(false)

    render(false)
    expect(state.expanded).toBe(false)

    act(() => state.toggle())
    expect(state.expanded).toBe(true)
  })

  it('reopens compact as a closed drawer rather than the wide preference', () => {
    render(false)
    expect(state.expanded).toBe(true)

    render(true)
    expect(state.expanded).toBe(false)
  })
})

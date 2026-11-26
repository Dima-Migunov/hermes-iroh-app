import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  FocusEvent as ReactFocusEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  RAIL_MARKER_HEIGHT_PX,
  TOOLTIP_MARGIN_PX,
  clampTooltipTop,
} from '../transcriptGeometry'

const RAIL_WIDTH_PX = 16
const TOOLTIP_GAP_PX = 8
const TOOLTIP_MAX_WIDTH_PX = 360
const TOOLTIP_MIN_WIDTH_PX = 160

export interface RailMarker {
  id: string
  ordinal: number
  preview: string
  text: string
  top: number
}

interface UserMessageRailProps {
  markers: RailMarker[]
  railRight: number
  railHeight: number
  onJump: (id: string) => void
}

interface TooltipLayout {
  top: number
  maxWidth: number
}

type InputModality = 'pointer' | 'keyboard'

function markerPreview(preview: string): string {
  return preview.replace(/\s+/g, ' ').trim()
}

function reportsKeyboardFocus(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return false
  }
}

export function UserMessageRail({
  markers,
  railRight,
  railHeight,
  onJump,
}: UserMessageRailProps) {
  const navRef = useRef<HTMLElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const modalityRef = useRef<InputModality>('pointer')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [tooltipLayout, setTooltipLayout] = useState<TooltipLayout | null>(null)

  const activeId = focusedId ?? hoveredId
  const active = activeId ? (markers.find((marker) => marker.id === activeId) ?? null) : null

  useEffect(() => {
    const handleKeyDown = (): void => {
      modalityRef.current = 'keyboard'
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  useLayoutEffect(() => {
    const nav = navRef.current
    const element = tooltipRef.current
    if (!active || !nav || !element) {
      setTooltipLayout(null)
      return
    }
    const shell = nav.parentElement ?? nav
    const availableWidth = Math.max(
      TOOLTIP_MIN_WIDTH_PX,
      shell.clientWidth - railRight - RAIL_WIDTH_PX - TOOLTIP_GAP_PX,
    )
    setTooltipLayout({
      top: clampTooltipTop(
        active.top + RAIL_MARKER_HEIGHT_PX / 2,
        element.offsetHeight,
        shell.clientHeight,
        TOOLTIP_MARGIN_PX,
      ),
      maxWidth: Math.min(TOOLTIP_MAX_WIDTH_PX, availableWidth),
    })
  }, [active, railRight])

  if (markers.length === 0) return null

  const handlePointerModality = (): void => {
    modalityRef.current = 'pointer'
  }

  const handlePointerEnter = (
    marker: RailMarker,
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (event.pointerType === 'touch') return
    modalityRef.current = 'pointer'
    setHoveredId(marker.id)
  }

  const handlePointerLeave = (marker: RailMarker): void => {
    setHoveredId((current) => (current === marker.id ? null : current))
  }

  const handleFocus = (
    marker: RailMarker,
    event: ReactFocusEvent<HTMLButtonElement>,
  ): void => {
    if (!reportsKeyboardFocus(event.currentTarget) && modalityRef.current !== 'keyboard') return
    setFocusedId(marker.id)
  }

  const handleBlur = (marker: RailMarker): void => {
    setFocusedId((current) => (current === marker.id ? null : current))
  }

  return (
    <nav
      ref={navRef}
      className="user-message-rail"
      aria-label="Your messages"
      style={{ right: railRight, height: railHeight }}
      onPointerDown={handlePointerModality}
    >
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          className={
            marker.id === activeId
              ? 'user-message-rail__marker user-message-rail__marker--active'
              : 'user-message-rail__marker'
          }
          style={{ top: marker.top }}
          aria-label={`Your message ${marker.ordinal} of ${markers.length}: ${markerPreview(
            marker.preview,
          )}`}
          onPointerEnter={(event) => handlePointerEnter(marker, event)}
          onPointerLeave={() => handlePointerLeave(marker)}
          onFocus={(event) => handleFocus(marker, event)}
          onBlur={() => handleBlur(marker)}
          onClick={() => onJump(marker.id)}
        >
          <span className="user-message-rail__line" aria-hidden="true" />
        </button>
      ))}

      {active ? (
        <div
          ref={tooltipRef}
          className="user-message-rail__tooltip"
          aria-hidden="true"
          style={{
            top: tooltipLayout ? `${tooltipLayout.top}px` : undefined,
            maxWidth: tooltipLayout ? `${tooltipLayout.maxWidth}px` : undefined,
            visibility: tooltipLayout ? 'visible' : 'hidden',
          }}
        >
          {active.text}
        </div>
      ) : null}
    </nav>
  )
}

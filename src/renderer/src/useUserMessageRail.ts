import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { StoredMessage } from '@shared/protocol'
import type { RailMarker } from './components/UserMessageRail'
import {
  MESSAGE_TOP_INSET_PX,
  markerTopsForDestinations,
  messageScrollDestination,
} from './transcriptGeometry'

const RAIL_GAP_PX = 4
const MAX_SCROLLBAR_WIDTH_PX = 24
// Overlay scrollbars report zero width, so reserve a fixed clearance to keep the
// marker buttons out of the scrollbar hit area.
const MIN_RAIL_RIGHT_PX = 16
const PREVIEW_MAX_LENGTH = 80

interface MeasuredRail {
  sessionId: string | null
  markers: RailMarker[]
  railRight: number
  railHeight: number
}

interface UserMessageRailState {
  markers: RailMarker[]
  railRight: number
  railHeight: number
}

function previewOf(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= PREVIEW_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, PREVIEW_MAX_LENGTH).trimEnd()}…`
}

function emptyRail(sessionId: string | null): MeasuredRail {
  return { sessionId, markers: [], railRight: 0, railHeight: 0 }
}

/**
 * Measures the transcript scroller and derives one rail marker per user
 * message. Markers are recomputed on a single animation frame after messages
 * change and whenever the scroller or content resizes.
 */
export function useUserMessageRail(
  messages: StoredMessage[],
  sessionId: string | null,
  containerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
): UserMessageRailState {
  const [state, setState] = useState<MeasuredRail>(() => emptyRail(null))
  const frameRef = useRef<number | null>(null)
  const hasUserMessages = messages.some((message) => message.role === 'user')

  const measure = useCallback((): void => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) {
      setState(emptyRail(sessionId))
      return
    }

    const viewportHeight = container.clientHeight
    const maxScroll = Math.max(0, container.scrollHeight - viewportHeight)
    const userMessages = messages.filter((message) => message.role === 'user')
    if (userMessages.length === 0 || maxScroll <= 0 || viewportHeight <= 0) {
      setState(emptyRail(sessionId))
      return
    }

    const anchors = new Map<string, HTMLElement>()
    content.querySelectorAll<HTMLElement>('[data-message-id]').forEach((element) => {
      const id = element.dataset.messageId
      if (id) anchors.set(id, element)
    })
    const contentTop = content.getBoundingClientRect().top
    const markers: RailMarker[] = []
    const destinations: number[] = []
    userMessages.forEach((message, index) => {
      const anchor = anchors.get(message.id)
      if (!anchor) return
      const offset = Math.max(0, anchor.getBoundingClientRect().top - contentTop)
      destinations.push(messageScrollDestination(offset, MESSAGE_TOP_INSET_PX, maxScroll))
      markers.push({
        id: message.id,
        ordinal: index + 1,
        preview: previewOf(message.content),
        text: message.content.trim(),
        top: 0,
      })
    })

    if (markers.length === 0) {
      setState(emptyRail(sessionId))
      return
    }

    const tops = markerTopsForDestinations(destinations, maxScroll, viewportHeight)
    const scrollbarWidth = Math.max(
      0,
      Math.min(MAX_SCROLLBAR_WIDTH_PX, container.offsetWidth - container.clientWidth),
    )
    setState({
      sessionId,
      markers: markers.map((marker, index) => ({ ...marker, top: tops[index] ?? 0 })),
      railRight: Math.max(scrollbarWidth + RAIL_GAP_PX, MIN_RAIL_RIGHT_PX),
      railHeight: viewportHeight,
    })
  }, [containerRef, contentRef, messages, sessionId])

  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  useEffect(() => {
    if (!hasUserMessages) return
    scheduleMeasure()
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [hasUserMessages, scheduleMeasure])

  const scheduleRef = useRef(scheduleMeasure)
  useEffect(() => {
    scheduleRef.current = scheduleMeasure
  }, [scheduleMeasure])

  useEffect(() => {
    if (!hasUserMessages) return
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return
    if (typeof ResizeObserver !== 'function') {
      const onResize = (): void => scheduleRef.current()
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    const observer = new ResizeObserver(() => scheduleRef.current())
    observer.observe(container)
    observer.observe(content)
    return () => observer.disconnect()
  }, [containerRef, contentRef, hasUserMessages])

  const current = state.sessionId === sessionId ? state : null
  return {
    markers: current?.markers ?? [],
    railRight: current?.railRight ?? 0,
    railHeight: current?.railHeight ?? 0,
  }
}

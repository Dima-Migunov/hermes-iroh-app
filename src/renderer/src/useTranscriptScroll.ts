import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { StoredMessage } from '@shared/protocol'

export const FOLLOW_THRESHOLD_PX = 48

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const MAX_PROGRAMMATIC_FRAMES = 600
const MIN_STABLE_FRAMES = 8
const STABLE_PROGRAMMATIC_FRAMES = 6

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

export interface TranscriptScroll {
  containerRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  newMessageCount: number
  hasUnseenActivity: boolean
  returnToLatest: () => void
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  )
}

function bottomOffset(container: HTMLDivElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight)
}

function distanceFromBottom(container: HTMLDivElement): number {
  return container.scrollHeight - container.scrollTop - container.clientHeight
}

/**
 * Owns transcript scroll accounting so the view component stays presentational.
 * `followingRef` is the source of truth: true means the newest content is kept
 * visible, false means the user is reading history and their position is kept.
 *
 * Any scroll event that is not part of a guarded return is a user scroll. The
 * browser does not emit a scroll event merely because content grew, so no
 * gesture heuristic is needed to distinguish streamed growth from a read-back.
 */
export function useTranscriptScroll(
  messages: StoredMessage[],
  sessionId: string | null,
): TranscriptScroll {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const programmaticFrameRef = useRef<number | null>(null)
  const programmaticCleanupRef = useRef<(() => void) | null>(null)
  const followFrameRef = useRef<number | null>(null)
  const scrollGenerationRef = useRef(0)
  const knownLengthsRef = useRef(new Map<string, number>())
  const seenSessionRef = useRef<string | null | undefined>(undefined)

  const [newMessageCount, setNewMessageCount] = useState(0)
  const [hasUnseenActivity, setHasUnseenActivity] = useState(false)

  const cancelFollowFrame = useCallback((): void => {
    if (followFrameRef.current === null) return
    cancelAnimationFrame(followFrameRef.current)
    followFrameRef.current = null
  }, [])

  const clearProgrammaticScroll = useCallback((): boolean => {
    const wasGuarded = programmaticScrollRef.current
    if (programmaticFrameRef.current !== null) {
      cancelAnimationFrame(programmaticFrameRef.current)
      programmaticFrameRef.current = null
    }
    programmaticCleanupRef.current?.()
    programmaticCleanupRef.current = null
    programmaticScrollRef.current = false
    return wasGuarded
  }, [])

  const endProgrammaticScroll = useCallback((): void => {
    if (!clearProgrammaticScroll()) return
    const container = containerRef.current
    if (!followingRef.current || !container) return
    container.scrollTop = bottomOffset(container)
  }, [clearProgrammaticScroll])

  const cancelProgrammaticScroll = useCallback((): void => {
    if (!clearProgrammaticScroll()) return
    const container = containerRef.current
    if (!container) return
    // Stop a native smooth animation in place; the user's gesture takes over.
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: container.scrollTop, behavior: 'auto' })
    }
  }, [clearProgrammaticScroll])

  const scheduleFollow = useCallback((): void => {
    if (!followingRef.current || programmaticScrollRef.current || followFrameRef.current !== null) {
      return
    }
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null
      if (!followingRef.current || programmaticScrollRef.current) return
      const container = containerRef.current
      if (container) container.scrollTop = bottomOffset(container)
    })
  }, [])

  const onScroll = useCallback((): void => {
    if (programmaticScrollRef.current) return
    const container = containerRef.current
    if (!container) return
    if (distanceFromBottom(container) <= FOLLOW_THRESHOLD_PX) {
      followingRef.current = true
      setNewMessageCount(0)
      setHasUnseenActivity(false)
      return
    }
    followingRef.current = false
  }, [])

  const returnToLatest = useCallback((): void => {
    followingRef.current = true
    setNewMessageCount(0)
    setHasUnseenActivity(false)

    const container = containerRef.current
    if (!container) return

    const start = container.scrollTop
    const target = bottomOffset(container)
    cancelFollowFrame()
    clearProgrammaticScroll()

    // An instant return needs no guard; it also keeps a submission while
    // already at the bottom from swallowing the user's next scroll gesture.
    if (
      prefersReducedMotion() ||
      Math.abs(start - target) <= 1 ||
      typeof container.scrollTo !== 'function'
    ) {
      if (start !== target) container.scrollTop = target
      return
    }

    scrollGenerationRef.current += 1
    const generation = scrollGenerationRef.current
    programmaticScrollRef.current = true

    const onEnd = (): void => {
      if (scrollGenerationRef.current !== generation) return
      endProgrammaticScroll()
    }
    container.addEventListener('scrollend', onEnd)
    programmaticCleanupRef.current = () => container.removeEventListener('scrollend', onEnd)

    container.scrollTo({ top: target, behavior: 'smooth' })

    // Fallback for engines without `scrollend`. Release only after the
    // position has been stable for several frames, or at a generous cap.
    let elapsed = 0
    let stable = 0
    let last = start
    const tick = (): void => {
      programmaticFrameRef.current = null
      if (!programmaticScrollRef.current || scrollGenerationRef.current !== generation) return
      elapsed += 1
      if (elapsed >= MAX_PROGRAMMATIC_FRAMES) {
        endProgrammaticScroll()
        return
      }
      const current = container.scrollTop
      if (Math.abs(current - last) < 1) {
        stable += 1
      } else {
        stable = 0
      }
      last = current
      if (elapsed >= MIN_STABLE_FRAMES && stable >= STABLE_PROGRAMMATIC_FRAMES) {
        endProgrammaticScroll()
        return
      }
      programmaticFrameRef.current = requestAnimationFrame(tick)
    }
    programmaticFrameRef.current = requestAnimationFrame(tick)
  }, [cancelFollowFrame, clearProgrammaticScroll, endProgrammaticScroll])

  useLayoutEffect(() => {
    const previous = knownLengthsRef.current

    if (seenSessionRef.current !== sessionId) {
      seenSessionRef.current = sessionId
      followingRef.current = true
      cancelFollowFrame()
      cancelProgrammaticScroll()
      setNewMessageCount(0)
      setHasUnseenActivity(false)
      knownLengthsRef.current = new Map(messages.map((message) => [message.id, message.content.length]))
      const container = containerRef.current
      if (container) container.scrollTop = bottomOffset(container)
      return
    }

    let added = 0
    let grew = false
    let ownSubmission = false
    const next = new Map<string, number>()
    for (const message of messages) {
      const knownLength = previous.get(message.id)
      if (knownLength === undefined) {
        added += 1
        if (message.role === 'user') ownSubmission = true
      } else if (message.content.length > knownLength) {
        grew = true
      }
      next.set(message.id, message.content.length)
    }
    knownLengthsRef.current = next

    if (ownSubmission) {
      returnToLatest()
      return
    }
    if (followingRef.current) return
    if (added > 0) setNewMessageCount((count) => count + added)
    if (grew) setHasUnseenActivity(true)
  }, [messages, sessionId, cancelFollowFrame, cancelProgrammaticScroll, returnToLatest])

  useLayoutEffect(() => {
    scheduleFollow()
  }, [messages, scheduleFollow])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(event.key)) cancelProgrammaticScroll()
    }

    container.addEventListener('wheel', cancelProgrammaticScroll, { passive: true })
    container.addEventListener('touchstart', cancelProgrammaticScroll, { passive: true })
    container.addEventListener('pointerdown', cancelProgrammaticScroll, { passive: true })
    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('wheel', cancelProgrammaticScroll)
      container.removeEventListener('touchstart', cancelProgrammaticScroll)
      container.removeEventListener('pointerdown', cancelProgrammaticScroll)
      container.removeEventListener('keydown', onKeyDown)
    }
  }, [cancelProgrammaticScroll])

  useEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return

    const handleResize = (): void => {
      if (programmaticScrollRef.current) return
      if (followingRef.current) {
        scheduleFollow()
        return
      }
      if (distanceFromBottom(container) <= FOLLOW_THRESHOLD_PX) {
        followingRef.current = true
        setNewMessageCount(0)
        setHasUnseenActivity(false)
        scheduleFollow()
      }
    }

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(handleResize)
      observer.observe(container)
      observer.observe(content)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [scheduleFollow])

  useEffect(
    () => () => {
      cancelFollowFrame()
      clearProgrammaticScroll()
    },
    [cancelFollowFrame, clearProgrammaticScroll],
  )

  return {
    containerRef,
    contentRef,
    onScroll,
    newMessageCount,
    hasUnseenActivity,
    returnToLatest,
  }
}

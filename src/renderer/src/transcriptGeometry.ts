/**
 * Pure geometry for the user-message rail. The renderer runs these against
 * measured element rectangles so the math stays testable without DOM layout.
 */

/** Distance kept between a jumped-to message and the top of the transcript. */
export const MESSAGE_TOP_INSET_PX = 16
/** Visual gap kept between adjacent rail markers when the track has room. */
export const MARKER_GAP_PX = 6
/** Height of a single marker button in the rail track. */
export const RAIL_MARKER_HEIGHT_PX = 8
/** Mandatory clearance below the transcript top, clear of the window controls. */
export const RAIL_TOP_INSET_PX = 32
/** Mandatory clearance above the transcript bottom, clear of the composer. */
export const RAIL_BOTTOM_INSET_PX = 24
/** Minimum vertical space between a tooltip and the chat edges. */
export const TOOLTIP_MARGIN_PX = 12

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Scroll offset that places a message at the top of the visible transcript,
 * clamped to the scrollable range.
 */
export function messageScrollDestination(
  messageTop: number,
  inset: number,
  maxScroll: number,
): number {
  const limit = Math.max(0, maxScroll)
  if (!Number.isFinite(messageTop)) return 0
  return clamp(messageTop - Math.max(0, inset), 0, limit)
}

/**
 * Rail position for a jump destination. Proportionally mirrors where the
 * scrollbar thumb would sit after the jump.
 */
export function markerTopForDestination(
  destination: number,
  maxScroll: number,
  trackHeight: number,
  markerHeight = 0,
): number {
  const range = Math.max(0, maxScroll)
  const track = Math.max(0, trackHeight - Math.max(0, markerHeight))
  if (range <= 0 || track <= 0) return 0
  return clamp(destination / range, 0, 1) * track
}

/**
 * Enforces a minimum gap between ordered marker tops. Markers are pushed down
 * in message order, then pulled up so the last one stays inside the track. If
 * the gap cannot fit for every marker, positions are distributed evenly and
 * markers overlap semantically while keeping their order and focusability.
 */
export function spreadMarkerTops(tops: number[], gap: number, maxTop: number): number[] {
  if (tops.length === 0) return []

  const limit = Math.max(0, maxTop)
  const spacing = Math.max(0, gap)
  const result = tops.map((top) => (Number.isFinite(top) ? clamp(top, 0, limit) : 0))

  for (let index = 1; index < result.length; index += 1) {
    result[index] = Math.max(result[index], result[index - 1] + spacing)
  }

  const last = result.length - 1
  if (result[last] > limit) {
    result[last] = limit
    for (let index = last - 1; index >= 0; index -= 1) {
      result[index] = Math.min(result[index], result[index + 1] - spacing)
    }

    if (result[0] < 0) {
      const step = result.length > 1 ? limit / (result.length - 1) : 0
      result[0] = 0
      for (let index = 1; index < result.length; index += 1) {
        result[index] = index * step
      }
    }
  }

  return result
}

/**
 * Marker tops for the given jump destinations. Destinations are mapped into
 * the usable track between the mandatory edge insets, gap-spread inside that
 * track, then shifted down by the top inset, so neither spreading nor the
 * overcrowded clamp can push a marker past either safety boundary.
 */
export function markerTopsForDestinations(
  destinations: number[],
  maxScroll: number,
  viewportHeight: number,
): number[] {
  const usableTrack = Math.max(
    0,
    viewportHeight - RAIL_MARKER_HEIGHT_PX - RAIL_TOP_INSET_PX - RAIL_BOTTOM_INSET_PX,
  )
  const tops = destinations.map((destination) =>
    markerTopForDestination(destination, maxScroll, usableTrack),
  )
  return spreadMarkerTops(tops, MARKER_GAP_PX, usableTrack).map(
    (top) => top + RAIL_TOP_INSET_PX,
  )
}

/**
 * Vertical position for a tooltip centered on a marker, kept fully inside the
 * chat area. A chat area shorter than the tooltip collapses to the top edge.
 */
export function clampTooltipTop(
  anchorCenter: number,
  tooltipHeight: number,
  shellHeight: number,
  margin: number,
): number {
  const safeMargin = Math.max(0, margin)
  const lower = Math.min(safeMargin, Math.max(0, shellHeight - tooltipHeight))
  const upper = Math.max(lower, shellHeight - tooltipHeight - safeMargin)
  const centered = anchorCenter - tooltipHeight / 2
  if (!Number.isFinite(centered)) return lower
  return clamp(centered, lower, upper)
}

import { describe, expect, it } from 'vitest'
import {
  MESSAGE_TOP_INSET_PX,
  RAIL_BOTTOM_INSET_PX,
  RAIL_MARKER_HEIGHT_PX,
  RAIL_TOP_INSET_PX,
  clampTooltipTop,
  markerTopForDestination,
  markerTopsForDestinations,
  messageScrollDestination,
  spreadMarkerTops,
} from '@renderer/transcriptGeometry'

describe('messageScrollDestination', () => {
  it('places a message at the top of the visible area below the inset', () => {
    expect(messageScrollDestination(500, MESSAGE_TOP_INSET_PX, 2000)).toBe(500 - MESSAGE_TOP_INSET_PX)
  })

  it('treats a message near the top as the start of the transcript', () => {
    expect(messageScrollDestination(5, MESSAGE_TOP_INSET_PX, 2000)).toBe(0)
  })

  it('never scrolls past the maximum scroll offset', () => {
    expect(messageScrollDestination(3000, MESSAGE_TOP_INSET_PX, 2000)).toBe(2000)
  })

  it('returns zero when the transcript does not scroll', () => {
    expect(messageScrollDestination(300, MESSAGE_TOP_INSET_PX, 0)).toBe(0)
    expect(messageScrollDestination(300, MESSAGE_TOP_INSET_PX, -40)).toBe(0)
  })
})

describe('markerTopForDestination', () => {
  it('maps the start of the scroll range to the top of the track', () => {
    expect(markerTopForDestination(0, 2000, 400, 2)).toBe(0)
  })

  it('maps a destination proportionally inside the track', () => {
    expect(markerTopForDestination(500, 2000, 400, 0)).toBe(100)
  })

  it('keeps the last destination fully inside the track', () => {
    expect(markerTopForDestination(2000, 2000, 400, 2)).toBe(398)
  })

  it('returns zero when there is no scrollable range', () => {
    expect(markerTopForDestination(100, 0, 400, 2)).toBe(0)
  })
})

describe('spreadMarkerTops', () => {
  it('leaves markers that are already separated untouched', () => {
    expect(spreadMarkerTops([0, 50, 100], 6, 100)).toEqual([0, 50, 100])
  })

  it('pushes later markers down to keep the minimum gap', () => {
    expect(spreadMarkerTops([10, 12, 14], 6, 100)).toEqual([10, 16, 22])
  })

  it('pulls earlier markers up when the last marker would leave the track', () => {
    expect(spreadMarkerTops([90, 98, 100], 6, 100)).toEqual([88, 94, 100])
  })

  it('preserves message order after spreading', () => {
    const spread = spreadMarkerTops([0, 0, 0, 0], 6, 100)

    expect(spread).toEqual([0, 6, 12, 18])
    expect([...spread].sort((left, right) => left - right)).toEqual(spread)
  })

  it('keeps every marker inside the track when the gap cannot fit', () => {
    const spread = spreadMarkerTops([0, 1, 2, 3, 4], 10, 20)

    expect(spread).toHaveLength(5)
    expect(spread[0]).toBeGreaterThanOrEqual(0)
    expect(spread[spread.length - 1]).toBeLessThanOrEqual(20)
    for (let index = 1; index < spread.length; index += 1) {
      expect(spread[index]).toBeGreaterThanOrEqual(spread[index - 1]!)
    }
  })

  it('handles a single marker and an empty track', () => {
    expect(spreadMarkerTops([5], 6, 100)).toEqual([5])
    expect(spreadMarkerTops([], 6, 100)).toEqual([])
    expect(spreadMarkerTops([5], 6, 0)).toEqual([0])
  })
})

describe('clampTooltipTop', () => {
  it('centers the tooltip on the marker', () => {
    expect(clampTooltipTop(200, 100, 800, 12)).toBe(150)
  })

  it('keeps the tooltip below the top edge', () => {
    expect(clampTooltipTop(10, 100, 800, 12)).toBe(12)
  })

  it('keeps the tooltip above the bottom edge', () => {
    expect(clampTooltipTop(790, 100, 800, 12)).toBe(800 - 100 - 12)
  })

  it('never returns a negative top for a short chat area', () => {
    expect(clampTooltipTop(5, 300, 200, 12)).toBe(0)
  })
})

describe('markerTopsForDestinations', () => {
  it('keeps the first and last markers inside the safety insets', () => {
    const tops = markerTopsForDestinations([0, 1000, 2000], 2000, 400)

    expect(tops[0]).toBe(RAIL_TOP_INSET_PX)
    expect(tops[tops.length - 1]).toBe(400 - RAIL_BOTTOM_INSET_PX - RAIL_MARKER_HEIGHT_PX)
  })

  it('keeps proportional positions inside the usable track', () => {
    const viewportHeight = 400
    const usableTrack =
      viewportHeight - RAIL_MARKER_HEIGHT_PX - RAIL_TOP_INSET_PX - RAIL_BOTTOM_INSET_PX
    const tops = markerTopsForDestinations([0, 500, 1000], 1000, viewportHeight)

    expect(tops[0]).toBe(RAIL_TOP_INSET_PX)
    expect(tops[1]).toBeCloseTo(RAIL_TOP_INSET_PX + usableTrack / 2)
    expect(tops[2]).toBeCloseTo(RAIL_TOP_INSET_PX + usableTrack)
  })

  it('preserves both insets when dense markers have to spread', () => {
    const tops = markerTopsForDestinations(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      1000,
      200,
    )

    expect(tops[0]).toBe(RAIL_TOP_INSET_PX)
    expect(tops[tops.length - 1]).toBeLessThanOrEqual(
      200 - RAIL_BOTTOM_INSET_PX - RAIL_MARKER_HEIGHT_PX,
    )
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index]).toBeGreaterThanOrEqual(tops[index - 1]!)
    }
  })

  it('keeps every marker inside the insets on a tiny usable track', () => {
    const tops = markerTopsForDestinations([0, 1000, 2000, 3000, 4000], 4000, 80)

    expect(tops[0]).toBe(RAIL_TOP_INSET_PX)
    expect(tops[tops.length - 1]).toBeLessThanOrEqual(
      80 - RAIL_BOTTOM_INSET_PX - RAIL_MARKER_HEIGHT_PX,
    )
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index]).toBeGreaterThanOrEqual(tops[index - 1]!)
    }
  })

  it('keeps the top inset when the viewport cannot fit the track', () => {
    expect(markerTopsForDestinations([0, 100], 100, 40)).toEqual([
      RAIL_TOP_INSET_PX,
      RAIL_TOP_INSET_PX,
    ])
  })
})

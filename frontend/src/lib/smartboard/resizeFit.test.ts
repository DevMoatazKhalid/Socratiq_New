import { describe, expect, it } from "vitest"
import { contentBounds, decideResizeView, isFullyVisible, makeMemo, visibleRect, type ViewState } from "./resizeFit"

const content = contentBounds([{ x: 100, y: 100, width: 1400, height: 800 }])!       // spans x 100..1500, y 100..900
const big: ViewState = { scrollX: 0, scrollY: 0, zoom: 1, width: 1600, height: 1000 }
const small: ViewState = { ...big, width: 600, height: 500 }                           // same scroll/zoom, narrower canvas: the bug scenario

describe("contentBounds", () => {
  it("ignores deleted elements, handles negative sizes, and returns null for an empty board", () => {
    expect(contentBounds([])).toBeNull()
    expect(contentBounds([{ x: 0, y: 0, width: 10, height: 10, isDeleted: true }])).toBeNull()
    expect(contentBounds([{ x: 50, y: 50, width: -20, height: -10 }, { x: 0, y: 0, width: 5, height: 5 }])).toEqual({ x1: 0, y1: 0, x2: 50, y2: 50 })
  })
})

describe("visibility maths", () => {
  it("visible rect follows scroll, zoom and canvas size", () => {
    expect(visibleRect({ scrollX: -200, scrollY: -50, zoom: 2, width: 800, height: 400 })).toEqual({ x1: 200, y1: 50, x2: 600, y2: 250 })
  })
  it("detects clipped content", () => {
    expect(isFullyVisible(content, big)).toBe(true)
    expect(isFullyVisible(content, small)).toBe(false)
  })
})

describe("decideResizeView", () => {
  it("SHRINK: content that was fully in view and is now clipped triggers a fit, remembering the previous view", () => {
    const d = decideResizeView(content, big, small, null)
    expect(d.kind).toBe("fit")
    if (d.kind === "fit") expect(d.before).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 })
  })
  it("does nothing when the smaller canvas still shows everything", () => {
    expect(decideResizeView(content, big, { ...big, width: 1550, height: 950 }, null).kind).toBe("none")
  })
  it("respects a deliberate zoomed-in view: content was already not fully in view before the resize", () => {
    const zoomedIn: ViewState = { scrollX: -300, scrollY: -300, zoom: 2, width: 1000, height: 700 }
    expect(decideResizeView(content, zoomedIn, { ...zoomedIn, width: 500 }, null).kind).toBe("none")
  })
  it("an empty board and a hidden (zero-size) panel never trigger anything", () => {
    expect(decideResizeView(null, big, small, null).kind).toBe("none")
    expect(decideResizeView(content, big, { ...big, width: 0, height: 0 }, null).kind).toBe("none")
  })
  it("GROW: after our fit, the previous view is restored once the canvas is big enough to show everything again", () => {
    const fitted = { scrollX: 40, scrollY: 30, zoom: 0.4 }
    const memo = makeMemo({ scrollX: 0, scrollY: 0, zoom: 1 }, fitted)
    const prev: ViewState = { ...fitted, width: 600, height: 500 }
    const d = decideResizeView(content, prev, { ...fitted, width: 1600, height: 1000 }, memo)
    expect(d).toEqual({ kind: "restore", view: { scrollX: 0, scrollY: 0, zoom: 1 }, memo: null })
  })
  it("GROW but not enough room for the old view: re-fit into the larger space instead of staying tiny", () => {
    const fitted = { scrollX: 40, scrollY: 30, zoom: 0.3 }
    const memo = makeMemo({ scrollX: 0, scrollY: 0, zoom: 1 }, fitted)
    const prev: ViewState = { ...fitted, width: 500, height: 400 }
    expect(decideResizeView(content, prev, { ...fitted, width: 900, height: 700 }, memo).kind).toBe("fit")
  })
  it("does not restore after the student zoomed or panned since our fit (their view wins)", () => {
    const memo = makeMemo({ scrollX: 0, scrollY: 0, zoom: 1 }, { scrollX: 40, scrollY: 30, zoom: 0.4 })
    const moved = { scrollX: 400, scrollY: 30, zoom: 0.4, width: 1600, height: 1000 }
    expect(decideResizeView(content, { ...moved, width: 600, height: 500 }, moved, memo).kind).not.toBe("restore")
    const zoomed = { scrollX: 40, scrollY: 30, zoom: 0.8, width: 1600, height: 1000 }
    expect(decideResizeView(content, { ...zoomed, width: 600, height: 500 }, zoomed, memo).kind).not.toBe("restore")
  })
  it("repeated shrink/grow cycles (window dragged back and forth) always end on the original view", () => {
    let memo = null as ReturnType<typeof makeMemo> | null
    let view: ViewState = { ...big }
    const sizes = [[600, 500], [1600, 1000], [500, 400], [1600, 1000], [700, 450], [1600, 1000]]
    for (const [w, h] of sizes) {
      const prev = view
      const next: ViewState = { ...view, width: w, height: h }
      const d = decideResizeView(content, prev, next, memo)
      if (d.kind === "fit") { const after = { scrollX: 20, scrollY: 20, zoom: Math.min(1, (w - 40) / 1400) }; memo = makeMemo(d.before, after); view = { ...after, width: w, height: h } }
      else if (d.kind === "restore") { memo = null; view = { ...d.view, width: w, height: h } }
      else { memo = d.memo; view = next }
    }
    expect(view).toEqual(big)
    expect(isFullyVisible(content, view)).toBe(true)
  })
})

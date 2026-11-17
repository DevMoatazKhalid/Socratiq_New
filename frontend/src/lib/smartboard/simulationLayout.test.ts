import { describe, expect, it } from "vitest"
import { isOffscreen, sameViewport, toScreenBox, type BoardViewport } from "./simulationLayout"

const vp = (o: Partial<BoardViewport> = {}): BoardViewport => ({ scrollX: 0, scrollY: 0, zoom: 1, width: 1000, height: 700, ...o })

describe("simulation layout (matches Excalidraw: screen = (scene + scroll) * zoom)", () => {
  it("maps scene coordinates through scroll and zoom", () => {
    expect(toScreenBox({ x: 100, y: 50, width: 520, height: 420 }, vp({ scrollX: -40, scrollY: 10, zoom: 2 }))).toEqual({ left: 120, top: 120, width: 1040, height: 840 })
  })
  it("detects cards fully outside the board, and treats partly visible ones as visible", () => {
    const v = vp()
    expect(isOffscreen({ left: 1100, top: 0, width: 100, height: 100 }, v)).toBe(true)
    expect(isOffscreen({ left: -300, top: 0, width: 100, height: 100 }, v)).toBe(true)
    expect(isOffscreen({ left: 950, top: 650, width: 100, height: 100 }, v)).toBe(false)
  })
  it("compares viewports by value", () => { expect(sameViewport(vp(), vp())).toBe(true); expect(sameViewport(vp(), vp({ zoom: 1.1 }))).toBe(false) })
})

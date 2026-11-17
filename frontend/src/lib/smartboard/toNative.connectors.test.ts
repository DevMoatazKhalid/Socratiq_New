// @vitest-environment jsdom
import "@/test/excalidrawEnv"
import { describe, expect, it } from "vitest"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { SPECS, spec } from "@/test/boardFactory"
import { layoutDiagram } from "./diagramLayout"
import { layoutToNative } from "./toNative"

/** 1.0 = exactly on the shape's outline, <1 inside, >1 outside (in units of the shape's own half-size). */
function radial(el: ExcalidrawElement, p: [number, number]): number {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2, dx = Math.abs(p[0] - cx) / (el.width / 2), dy = Math.abs(p[1] - cy) / (el.height / 2)
  if (el.type === "ellipse") return Math.hypot(dx, dy)
  if (el.type === "diamond") return dx + dy
  return Math.max(dx, dy)
}

describe("generated connectors really connect the boxes they claim to connect", () => {
  for (const kind of Object.keys(SPECS) as (keyof typeof SPECS)[]) {
    it(`${kind}: every bound arrow starts and ends ON its two shapes (not in empty space)`, () => {
      const layout = layoutDiagram(spec(kind))
      const els = layoutToNative(layout, { offset: { x: 600, y: 300 }, opId: "op1", groupId: "g1", now: 1 }).elements
      const byId = new Map(els.map((e) => [e.id, e]))
      const bad: string[] = []
      for (const a of els) {
        if (a.type !== "arrow") continue
        const arrow = a as unknown as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null; points: [number, number][] }
        const start: [number, number] = [a.x + arrow.points[0][0], a.y + arrow.points[0][1]]
        const end: [number, number] = [a.x + arrow.points[arrow.points.length - 1][0], a.y + arrow.points[arrow.points.length - 1][1]]
        for (const [bind, pt, label] of [[arrow.startBinding, start, "start"], [arrow.endBinding, end, "end"]] as const) {
          const target = bind ? byId.get(bind.elementId) : undefined
          if (!target) continue
          const r = radial(target, pt)
          if (r < 0.8 || r > 1.45) bad.push(`${a.id} ${label} -> ${target.type} ${target.id}: radial=${r.toFixed(2)} at (${pt.map(Math.round)})`)
        }
      }
      expect(bad).toEqual([])
    })
  }
})

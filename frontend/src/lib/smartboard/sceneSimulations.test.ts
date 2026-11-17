// @vitest-environment jsdom
import "@/test/excalidrawEnv"
import { describe, expect, it } from "vitest"
import { buildStoredScene, restoreStoredScene } from "./scene"
import { planSimulationInsertion } from "./insertSimulation"

const sim = (id: string, n = 1) => ({ id, title: `T${id}`, code: `<script>requestAnimationFrame(function f(){requestAnimationFrame(f)})</script><!--${"x".repeat(n)}-->` })

describe("simulations in the saved scene", () => {
  it("round-trips: code is saved beside the elements, not inside them, and restored", () => {
    const big = sim("a", 50_000)
    const plan = planSimulationInsertion({ simulation: big, elements: [], opId: "o" })
    if (!plan.ok) throw new Error("plan failed")
    const stored = buildStoredScene(plan.all, {}, {}, { a: big })
    expect(stored.simulations?.a.code).toBe(big.code)
    expect(JSON.stringify(stored.elements)).not.toContain("xxxxxxxx")       // nothing large inside elements (server caps customData at 4000 chars)
    const back = restoreStoredScene(JSON.parse(JSON.stringify(stored)))
    expect(back.simulations.a).toEqual(big)
    expect(back.elements.some((e) => (e.customData as any)?.simulationRef?.id === "a")).toBe(true)
  })
  it("persists only records that an element still references, and omits the key when there are none", () => {
    const a = sim("a"), b = sim("b")
    const plan = planSimulationInsertion({ simulation: a, elements: [], opId: "o" })
    if (!plan.ok) throw new Error("plan failed")
    expect(Object.keys(buildStoredScene(plan.all, {}, {}, { a, b }).simulations ?? {})).toEqual(["a"])
    expect("simulations" in buildStoredScene([], {}, {}, { a, b })).toBe(false)
  })
  it("a scene from an older client (no simulations key) restores with an empty map", () => {
    expect(restoreStoredScene({ version: 2, type: "excalidraw", elements: [], appState: {}, files: {} }).simulations).toEqual({})
  })
})

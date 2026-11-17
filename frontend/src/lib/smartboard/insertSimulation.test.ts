// @vitest-environment jsdom
import "@/test/excalidrawEnv"
import { describe, expect, it } from "vitest"
import { planSimulationInsertion, SIM_CARD_H, SIM_CARD_W } from "./insertSimulation"
import { resolveSimulation } from "./simulationRef"
import type { SceneEl } from "./types"

describe("planSimulationInsertion", () => {
  const sampleSim = {
    id: "sim-harmonic",
    title: "Harmonic Oscillator",
    code: "<canvas id='c'></canvas><script>let k=0.5; let m=1.0;</script>",
  }

  it("inserts a card that only REFERENCES the simulation: no code in customData, no placeholder label", () => {
    const res = planSimulationInsertion({ simulation: sampleSim, elements: [], opId: "test-sim-op" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const card = res.added[0]
    expect(card.type).toBe("rectangle")
    expect(card.width).toBe(SIM_CARD_W)
    expect(card.height).toBe(SIM_CARD_H)
    const custom = card.customData?.socratiq as any
    expect(custom.role).toBe("simulation")
    expect(custom.author).toBe("ai")                 // AI-generated, not student work and not Coach-signed (the server would demote an unsigned "coach" claim)
    const cd = card.customData as any
    expect(cd.simulationRef).toEqual({ id: "sim-harmonic", title: "Harmonic Oscillator" })
    // REGRESSION (root cause): code in customData exceeds the server's 4000-char cap and got the whole board rejected on save.
    expect(cd.simulation).toBeUndefined()
    expect(JSON.stringify(card.customData)).not.toContain("let k=0.5")
    expect(res.added.some((e) => e.type === "text")).toBe(false)        // no "Click 'Open Simulation'" label: the live simulation is the content
    expect(res.simulation).toEqual(sampleSim)                           // the record is returned for the scene's `simulations` map
  })

  it("avoids colliding with existing board obstacles when placed", () => {
    const existing: SceneEl[] = [
      {
        id: "box1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        isDeleted: false,
      } as any,
    ]

    const res = planSimulationInsertion({
      simulation: sampleSim,
      elements: existing as any,
      opId: "test-sim-op-2",
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      const card = res.added[0]
      const overlaps =
        card.x < 400 && card.x + card.width > 0 && card.y < 400 && card.y + card.height > 0
      expect(overlaps).toBe(false)
    }
  })

  it("a serialized card resolves back to its code through the scene map, and legacy inline cards still resolve", () => {
    const res = planSimulationInsertion({ simulation: sampleSim, elements: [], opId: "test-sim-op-3" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const serialized = JSON.parse(JSON.stringify(res.added[0]))
    expect(resolveSimulation(serialized, { [sampleSim.id]: sampleSim })).toEqual(sampleSim)
    expect(resolveSimulation(serialized, {})).toBeNull()                                   // data missing -> null, the layer shows a clear message
    const legacy = { ...serialized, customData: { socratiq: { role: "simulation" }, simulation: sampleSim } }
    expect(resolveSimulation(legacy, {})).toEqual(sampleSim)                               // boards saved by earlier clients keep working
  })
})

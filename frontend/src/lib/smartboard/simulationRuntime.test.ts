import { describe, expect, it } from "vitest"
import { controlMessage, parseSimMessage, SIM_HOST_RUNTIME } from "./simulationRuntime"
import { buildSimulationSrcDoc } from "./simulationDoc"

describe("simulation message protocol (untrusted input from a frame)", () => {
  it("accepts exactly the protocol and truncates text", () => {
    expect(parseSimMessage({ __sq: 1, type: "loaded" })).toEqual({ type: "loaded" })
    expect(parseSimMessage({ __sq: 1, type: "error", message: "x".repeat(1000) })).toEqual({ type: "error", message: "x".repeat(300) })
  })
  it.each([null, "loaded", 5, {}, { type: "loaded" }, { __sq: 2, type: "loaded" }, { __sq: 1, type: "control" }, { __sq: 1, type: "error" }, { __sq: 1, type: "error", message: 4 }, { __sq: 1, type: "eval", message: "x" }])(
    "rejects %j", (bad) => expect(parseSimMessage(bad)).toBeNull())
  it("control messages carry only valid fields", () => {
    expect(controlMessage({ paused: true, speed: 2, hidden: false })).toEqual({ __sq: 1, type: "control", paused: true, speed: 2, hidden: false })
    expect(controlMessage({ speed: 0 }).speed).toBeUndefined()
    expect(controlMessage({ speed: 99 }).speed).toBeUndefined()
    expect(controlMessage({ speed: NaN }).speed).toBeUndefined()
    expect(controlMessage({ paused: "yes" as never }).paused).toBeUndefined()
  })
})

describe("srcdoc assembly", () => {
  const doc = buildSimulationSrcDoc("<script>requestAnimationFrame(function f(){requestAnimationFrame(f)})</script>")
  it("installs the host runtime and loop guard BEFORE generated code", () => {
    expect(doc.indexOf(SIM_HOST_RUNTIME)).toBeGreaterThan(-1)
    expect(doc.indexOf("__lgEnter")).toBeLessThan(doc.indexOf(SIM_HOST_RUNTIME))
    expect(doc.indexOf(SIM_HOST_RUNTIME)).toBeLessThan(doc.indexOf("requestAnimationFrame(function f()"))
  })
  it("loads Tailwind without blocking the parser (root cause: a slow CDN froze the simulation)", () => {
    expect(doc).toMatch(/<script async src="https:\/\/cdn\.tailwindcss\.com/)
    expect(doc).not.toMatch(/<script src="https:\/\/cdn\.tailwindcss\.com/)
  })
  it("keeps the network lockdown", () => { expect(doc).toContain("connect-src 'none'"); expect(doc).toContain("default-src 'none'") })
})

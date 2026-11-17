// @vitest-environment jsdom
import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { BoardSimulationLayer, SIM_START_TIMEOUT_MS } from "./BoardSimulationLayer"
import type { BoardViewport } from "@/lib/smartboard/simulationLayout"

const CODE = "<canvas id=c></canvas><script>requestAnimationFrame(function f(){requestAnimationFrame(f)})</script>"
const card = (id = "c1", o: any = {}) => ({ id, type: "rectangle", x: 100, y: 50, width: 520, height: 420, angle: 0, isDeleted: false, version: 1,
  customData: { socratiq: { role: "simulation", author: "ai" }, simulationRef: { id: `s-${id}`, title: "Pendulum" } }, ...o }) as any
const rec = (id = "c1", code = CODE) => ({ [`s-${id}`]: { id: `s-${id}`, title: "Pendulum", code } })
const vp = (o: Partial<BoardViewport> = {}): BoardViewport => ({ scrollX: 0, scrollY: 0, zoom: 1, width: 1000, height: 700, ...o })
const mount = (p: Partial<React.ComponentProps<typeof BoardSimulationLayer>> = {}) =>
  render(<div data-testid="board"><BoardSimulationLayer elements={[card()]} records={rec()} viewport={vp()} interactive onRemove={() => {}} {...p} /></div>)
afterEach(() => { cleanup(); vi.useRealTimers() })

describe("BoardSimulationLayer", () => {
  it("renders the simulation INSIDE the board container, in a sandboxed frame without same-origin", () => {
    mount()
    const board = screen.getByTestId("board"), frame = board.querySelector("iframe")!
    expect(board.contains(frame)).toBe(true)
    expect(frame.closest("[data-sim-layer]")).not.toBeNull()
    const sb = frame.getAttribute("sandbox")!
    expect(sb).toContain("allow-scripts"); expect(sb).not.toContain("allow-same-origin"); expect(sb).not.toContain("allow-top-navigation")
    expect(frame.getAttribute("srcdoc")).toContain("requestAnimationFrame(function f()")
    expect(getComputedStyle(board.querySelector("[data-sim-layer]")!).position).toBe("absolute")     // not position: fixed (the old page-level panel)
    expect(board.querySelector("[style*='fixed']")).toBeNull()
  })
  it("is positioned and scaled by the board's own viewport", () => {
    mount({ viewport: vp({ scrollX: -40, scrollY: 10, zoom: 2 }) })
    const el = document.querySelector<HTMLElement>("[data-sim-card]")!
    expect(el.style.transform).toBe("translate(120px, 120px) scale(2)")
    expect(el.style.width).toBe("520px")
  })
  it("hides a card that is entirely off screen", () => {
    mount({ viewport: vp({ scrollX: -5000 }) })
    expect(document.querySelector<HTMLElement>("[data-sim-card]")!.style.display).toBe("none")
  })
  it("renders only live simulation cards (deleted and ordinary elements are ignored)", () => {
    mount({ elements: [card("a"), card("b", { isDeleted: true }), { ...card("c"), customData: {} }], records: { ...rec("a"), ...rec("b"), ...rec("c") } })
    expect(document.querySelectorAll("[data-sim-card]").length).toBe(1)
  })
  it("two cards get two independent frames and independent controls", () => {
    mount({ elements: [card("a"), card("b")], records: { ...rec("a"), ...rec("b") } })
    expect(document.querySelectorAll("iframe").length).toBe(2)
    fireEvent.click(document.querySelector("[data-sim-card='a'] [data-sim-action='toggle']")!)
    expect(document.querySelector("[data-sim-card='a']")!.getAttribute("data-paused")).toBe("true")
    expect(document.querySelector("[data-sim-card='b']")!.getAttribute("data-paused")).toBe("false")
  })
  it("pause/play/speed/hidden are sent to that card's frame only", () => {
    mount({ elements: [card("a"), card("b")], records: { ...rec("a"), ...rec("b") } })
    const fa = document.querySelector<HTMLIFrameElement>("[data-sim-frame='a']")!, fb = document.querySelector<HTMLIFrameElement>("[data-sim-frame='b']")!
    const sa = vi.spyOn(fa.contentWindow!, "postMessage"), sb = vi.spyOn(fb.contentWindow!, "postMessage")
    fireEvent.click(document.querySelector("[data-sim-card='a'] [data-sim-action='toggle']")!)
    fireEvent.change(document.querySelector("[data-sim-card='a'] [data-sim-action='speed']")!, { target: { value: "2" } })
    expect(sa).toHaveBeenCalledWith({ __sq: 1, type: "control", paused: true }, "*")
    expect(sa).toHaveBeenCalledWith({ __sq: 1, type: "control", speed: 2 }, "*")
    expect(sb.mock.calls.some((c) => (c[0] as any).paused === true)).toBe(false)
  })
  it("reset remounts the frame and restores play/1x", () => {
    mount()
    const before = document.querySelector("iframe")!
    fireEvent.click(document.querySelector("[data-sim-action='toggle']")!)
    fireEvent.click(document.querySelector("[data-sim-action='reset']")!)
    expect(document.querySelector("iframe")).not.toBe(before)
    expect(document.querySelector("[data-sim-card]")!.getAttribute("data-paused")).toBe("false")
  })
  it("only believes messages from its own frame; shows errors from it", () => {
    mount()
    const f = document.querySelector("iframe")!
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: { __sq: 1, type: "error", message: "from-elsewhere" }, source: window })) })
    expect(screen.queryByRole("alert")).toBeNull()
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: { __sq: 1, type: "loaded" }, source: f.contentWindow })) })
    expect(document.querySelector("[data-sim-card]")!.getAttribute("data-status")).toBe("running")
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: { __sq: 1, type: "error", message: "boom is not defined" }, source: f.contentWindow })) })
    expect(screen.getByRole("alert").textContent).toContain("boom is not defined")
  })
  it("a simulation that never loads is reported as failed, not left blank", () => {
    vi.useFakeTimers(); mount()
    act(() => { vi.advanceTimersByTime(SIM_START_TIMEOUT_MS + 50) })
    expect(document.querySelector("[data-sim-card]")!.getAttribute("data-status")).toBe("failed")
    expect(screen.getByRole("alert").textContent).toContain("did not start")
  })
  it("malicious code is never put in a frame; missing data shows a message", () => {
    mount({ records: rec("c1", "<script>window.parent.x</script>") })
    expect(document.querySelector("iframe")).toBeNull()
    expect(document.querySelector("[data-sim-message]")!.textContent).toContain("blocked")
    cleanup(); mount({ records: {} })
    expect(document.querySelector("iframe")).toBeNull()
    expect(document.querySelector("[data-sim-message]")!.textContent).toContain("missing")
  })
  it("the simulation body only takes the pointer while select/hand is active (drawing across it still draws)", () => {
    mount({ interactive: false })
    expect(document.querySelector("iframe")!.style.pointerEvents).toBe("none")
    cleanup(); mount({ interactive: true })
    expect(document.querySelector("iframe")!.style.pointerEvents).toBe("auto")
  })
  it("remove is offered to editors only, and reports the element id", () => {
    const onRemove = vi.fn(); mount({ onRemove })
    fireEvent.click(document.querySelector("[data-sim-action='remove']")!)
    expect(onRemove).toHaveBeenCalledWith("c1")
    cleanup(); mount({ readOnly: true })
    expect(document.querySelector("[data-sim-action='remove']")).toBeNull()
  })
  it("unmounting (card deleted) removes the frame, which destroys the simulation's document", () => {
    const { rerender } = mount()
    expect(document.querySelectorAll("iframe").length).toBe(1)
    rerender(<div data-testid="board"><BoardSimulationLayer elements={[card("c1", { isDeleted: true })]} records={rec()} viewport={vp()} interactive /></div>)
    expect(document.querySelectorAll("iframe").length).toBe(0)
  })
})

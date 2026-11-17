// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  data: undefined as unknown,
}))
vi.mock("@/lib/queries", () => ({ usePersonas: () => ({ data: h.data }), useSetPersona: () => ({ mutate: h.mutate }) }))

import { PersonaSelector } from "./PersonaSelector"
import { ResizableSplit, MIN_PCT, MAX_PCT, clampPct } from "./ResizableSplit"

const personas = ["socratic_guide", "patient_mentor", "practical_engineer", "critical_thinker", "visual_explorer"].map((id, i) => ({
  id, version: 1, name: { en: ["The Socratic Guide", "The Patient Mentor", "The Practical Engineer", "The Critical Thinker", "The Visual Explorer"][i], ar: ["المرشد السقراطي", "المعلّم الصبور", "المهندس العملي", "المفكّر الناقد", "المستكشف البصري"][i] },
  tagline: { en: "t", ar: "ت" }, description: { en: `desc ${id}`, ar: `وصف ${id}` }, tone: "x", formality: "balanced",
}))

beforeEach(() => { h.mutate.mockReset(); h.data = { personas, selected: { id: "socratic_guide", version: 1 }, default: "socratic_guide" }; localStorage.clear() })
afterEach(cleanup)

describe("PersonaSelector", () => {
  it("renders nothing until the personas are known (never a blocking control)", () => {
    h.data = undefined
    const { container } = render(<PersonaSelector assignmentId="A1" />)
    expect(container.querySelector("button")).toBeNull()
  })

  it("shows the current style, lists all five with both languages, and marks the selected one", () => {
    render(<PersonaSelector assignmentId="A1" />)
    fireEvent.click(screen.getByRole("button", { name: /Teaching style: The Socratic Guide/ }))
    const radios = screen.getAllByRole("radio")
    expect(radios).toHaveLength(5)
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1)
    expect(screen.getByText("المعلّم الصبور")).toBeTruthy()
    expect(screen.getByText("desc visual_explorer")).toBeTruthy()
    expect(screen.getByText(/never changes what help is allowed/)).toBeTruthy()
  })

  it("choosing another style saves it for this assignment and closes; choosing the current one does nothing", () => {
    render(<PersonaSelector assignmentId="A1" />)
    fireEvent.click(screen.getByRole("button", { name: /Teaching style/ }))
    fireEvent.click(screen.getByRole("radio", { name: /The Visual Explorer/ }))
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][0]).toEqual({ personaId: "visual_explorer", assignmentId: "A1" })
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Teaching style/ }))
    fireEvent.click(screen.getByRole("radio", { name: /The Socratic Guide/ }))
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it("announces the change, and a refusal, without losing the previous style", () => {
    render(<PersonaSelector assignmentId="A1" />)
    fireEvent.click(screen.getByRole("button", { name: /Teaching style/ }))
    fireEvent.click(screen.getByRole("radio", { name: /The Patient Mentor/ }))
    act(() => h.mutate.mock.calls[0][1].onSuccess())
    expect(screen.getByRole("status").textContent).toMatch(/changed to The Patient Mentor.*continues/)
    act(() => h.mutate.mock.calls[0][1].onError())
    expect(screen.getByRole("status").textContent).toMatch(/previous style is still active/)
  })

  it("Escape closes the panel and it can be disabled while a reply is being produced", () => {
    const { rerender } = render(<PersonaSelector />)
    fireEvent.click(screen.getByRole("button", { name: /Teaching style/ }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
    rerender(<PersonaSelector disabled />)
    expect((screen.getByRole("button", { name: /Teaching style/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("ResizableSplit", () => {
  const mount = (collapsed: "left" | "right" | null = null) => render(<ResizableSplit collapsed={collapsed} left={<p>chat pane</p>} right={<p>board pane</p>} />)
  const sep = () => screen.getByRole("separator")

  it("keeps BOTH panes mounted when one is collapsed (board state and chat scroll survive)", () => {
    const { rerender } = mount("left")
    expect(screen.getByText("chat pane").closest("section")!.className).toMatch(/hidden/)
    expect(screen.getByText("board pane")).toBeTruthy()
    rerender(<ResizableSplit collapsed="right" left={<p>chat pane</p>} right={<p>board pane</p>} />)
    expect(screen.getByText("board pane").closest("section")!.className).toMatch(/hidden/)
    expect(screen.getByText("chat pane").closest("section")!.className).not.toMatch(/hidden/)
    expect(screen.queryByRole("separator")).toBeNull()                       // nothing to resize with one pane
  })

  it("is a keyboard-operable window splitter that clamps and persists", () => {
    mount()
    expect(sep().getAttribute("aria-valuenow")).toBe("40")
    fireEvent.keyDown(sep(), { key: "ArrowRight" })
    expect(sep().getAttribute("aria-valuenow")).toBe("42")
    fireEvent.keyDown(sep(), { key: "ArrowLeft", shiftKey: true })
    expect(sep().getAttribute("aria-valuenow")).toBe("32")
    fireEvent.keyDown(sep(), { key: "End" })
    expect(sep().getAttribute("aria-valuenow")).toBe(String(MAX_PCT))
    fireEvent.keyDown(sep(), { key: "ArrowRight", shiftKey: true })
    expect(sep().getAttribute("aria-valuenow")).toBe(String(MAX_PCT))      // clamped
    fireEvent.keyDown(sep(), { key: "Home" })
    expect(sep().getAttribute("aria-valuenow")).toBe(String(MIN_PCT))
    expect(localStorage.getItem("socratiq.workspace.split")).toBe(String(MIN_PCT))
    fireEvent.keyDown(sep(), { key: "Enter" })
    expect(sep().getAttribute("aria-valuenow")).toBe("40")
  })

  it("restores a stored width and ignores garbage", () => {
    localStorage.setItem("socratiq.workspace.split", "55")
    mount()
    expect(sep().getAttribute("aria-valuenow")).toBe("55")
    cleanup()
    localStorage.setItem("socratiq.workspace.split", "banana")
    mount()
    expect(sep().getAttribute("aria-valuenow")).toBe("40")
  })

  it("clampPct bounds any value", () => { expect(clampPct(-5)).toBe(MIN_PCT); expect(clampPct(500)).toBe(MAX_PCT); expect(clampPct(50.04)).toBe(50) })
})

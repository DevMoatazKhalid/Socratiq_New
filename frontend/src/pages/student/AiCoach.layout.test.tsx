// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs } from "@/test/domStubs"

const h = vi.hoisted(() => ({
  send: vi.fn(),
  save: vi.fn(async (..._a: unknown[]) => ({})),
  state: {
    board: { steps: [] as string[], strokes: [] as unknown[], elements: [] as unknown[], nextSeq: 0 },
    assignment: { id: "A1", title: "Gradient descent", topic: "Gradient descent", dueDate: "2099-01-01T00:00:00Z", status: "in_progress" },
  },
}))

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
vi.mock("@/lib/queries", () => ({
  sendCoachStream: (...a: unknown[]) => h.send(...a),
  saveWhiteboard: (...a: unknown[]) => h.save(...a),
  useCoachHistory: () => ({ data: [], isPending: false }),
  useStartAttempt: () => ({ mutate: vi.fn() }),
  useStudentAssignment: () => ({ data: h.state.assignment }),
  useStudentCourse: () => ({ data: { course: { name: "CS101" } } }),
  usePersonas: () => ({ data: undefined }),          // the persona selector renders nothing without data; it has its own tests
  useSetPersona: () => ({ mutate: vi.fn() }),
  useWhiteboard: () => ({ data: h.state.board, isError: false }),
}))
const shellProps = vi.hoisted(() => ({ fit: undefined as unknown }))
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children, fitViewport }: { children: React.ReactNode; fitViewport?: boolean }) => { shellProps.fit = fitViewport; return <div>{children}</div> } }))
vi.mock("@/components/ui/States", () => ({ QueryState: ({ query, children }: { query: { data: unknown }; children: (d: unknown) => React.ReactNode }) => children(query.data) }))

import AiCoach from "./AiCoach"

const reply = (text = "Here is the first step.") => ({
  interactionId: "i1", turn: 1, sources: [],
  message: { id: "m1", role: "coach", content: text },
  board: { steps: [], strokes: [], elements: [], nextSeq: 0, report: { applied: [], rejected: [] } },
})

beforeEach(() => {
  vi.stubEnv("VITE_SMARTBOARD_ENGINE", "legacy")
  installDomStubs()
  if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => Math.random().toString(36).slice(2) }, configurable: true })
  h.send.mockReset()
  h.save.mockClear()
  h.state.board = { steps: [], strokes: [], elements: [], nextSeq: 0 }
  shellProps.fit = undefined
})
afterEach(() => { cleanup(); vi.unstubAllEnvs() })

const mount = () => render(
  <MemoryRouter initialEntries={["/student/courses/C1/assignments/A1/coach"]}>
    <Routes><Route path="/student/courses/:courseId/assignments/:assignmentId/coach" element={<AiCoach />} /></Routes>
  </MemoryRouter>,
)
const box = () => screen.getByLabelText("Message SocratiQ AI") as HTMLTextAreaElement
/** jsdom does no layout, so give the transcript scroll container real-looking metrics. */
function metrics(el: HTMLElement, o: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, "scrollHeight", { value: o.scrollHeight, configurable: true })
  Object.defineProperty(el, "clientHeight", { value: o.clientHeight, configurable: true })
  el.scrollTop = o.scrollTop
}

describe("Coach workspace layout contract", () => {
  it("opts into the fixed-height shell, so the composer cannot be pushed below the viewport", () => {
    mount()
    expect(shellProps.fit).toBe(true)
  })

  it("the transcript is the only scroller: it flexes, scrolls, and sits above a non-shrinking composer", () => {
    mount()
    const chat = document.getElementById("coach-panel-chat")!
    expect(chat.className).toContain("flex-1")
    expect(chat.className).toContain("overflow-y-auto")
    const form = box().closest("form")!
    expect(form.className).toContain("shrink-0")
    expect(form.className).toContain("flex-wrap")                   // mobile: the text field gets its own row instead of being squeezed by 4 buttons
    expect(form.parentElement).toBe(chat.parentElement)              // same panel column...
    expect(chat.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()   // ...with the composer below the transcript
  })
})

describe("Composer", () => {
  it("is a multi-line field that Enter sends and Shift+Enter does not", async () => {
    h.send.mockResolvedValue(reply())
    mount()
    expect(box().tagName).toBe("TEXTAREA")
    fireEvent.change(box(), { target: { value: "line one" } })
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true })
    expect(h.send).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: "Enter" })
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))
  })

  it("does not send while an input method (e.g. Arabic IME) is still composing a word", () => {
    mount()
    fireEvent.change(box(), { target: { value: "مرحبا" } })
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true })
    expect(h.send).not.toHaveBeenCalled()
  })

  it("grows with its content up to a cap, then scrolls inside itself", () => {
    mount()
    Object.defineProperty(box(), "scrollHeight", { value: 90, configurable: true })
    fireEvent.change(box(), { target: { value: "a\nb\nc" } })
    expect(box().style.height).toBe("90px")
    Object.defineProperty(box(), "scrollHeight", { value: 600, configurable: true })
    fireEvent.change(box(), { target: { value: "a\nb\nc\nd" } })
    expect(box().style.height).toBe("144px")
  })
})

describe("Transcript scrolling", () => {
  it("follows a reply when the student is at the bottom, and a message they send returns them to the latest", async () => {
    let resolve!: (v: unknown) => void
    h.send.mockImplementation(() => new Promise((r) => { resolve = r }))
    mount()
    const chat = document.getElementById("coach-panel-chat") as HTMLDivElement
    const scrollTo = vi.fn(); chat.scrollTo = scrollTo as never
    metrics(chat, { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 })
    fireEvent.scroll(chat)
    fireEvent.change(box(), { target: { value: "hi" } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    scrollTo.mockClear()
    await act(async () => { resolve(reply("A reply")) })
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
  })

  it("does NOT yank the student down when they have scrolled up to read older messages", async () => {
    let resolve!: (v: unknown) => void
    h.send.mockImplementation(() => new Promise((r) => { resolve = r }))
    mount()
    const chat = document.getElementById("coach-panel-chat") as HTMLDivElement
    const scrollTo = vi.fn(); chat.scrollTo = scrollTo as never
    fireEvent.change(box(), { target: { value: "hi" } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())       // their own message: scrolled to
    scrollTo.mockClear()
    metrics(chat, { scrollHeight: 3000, clientHeight: 400, scrollTop: 300 })   // now they scroll far up while the reply is pending
    fireEvent.scroll(chat)
    await act(async () => { resolve(reply("A long reply arriving")) })
    await waitFor(() => expect(screen.getByText("A long reply arriving")).toBeTruthy())
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

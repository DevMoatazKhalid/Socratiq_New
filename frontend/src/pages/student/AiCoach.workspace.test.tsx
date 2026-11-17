// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs } from "@/test/domStubs"

const h = vi.hoisted(() => ({
  send: vi.fn(),
  refetch: vi.fn(),
  wide: true,
  assignment: { id: "A1", title: "Gradient descent", topic: "Gradient descent", dueDate: "2099-01-01T00:00:00Z", status: "in_progress" },
}))

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
vi.mock("@/lib/queries", () => ({
  sendCoachStream: (...a: unknown[]) => h.send(...a),
  saveWhiteboard: async () => ({}),
  useCoachHistory: () => ({ data: [], isPending: false, refetch: h.refetch }),
  useStartAttempt: () => ({ mutate: vi.fn() }),
  useStudentAssignment: () => ({ data: h.assignment }),
  useStudentCourse: () => ({ data: { course: { name: "CS101" } } }),
  useWhiteboard: () => ({ data: { steps: [], strokes: [], elements: [], nextSeq: 0 }, isError: false }),
  usePersonas: () => ({ data: undefined }),
  useSetPersona: () => ({ mutate: vi.fn() }),
}))
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock("@/components/ui/States", () => ({ QueryState: ({ query, children }: { query: { data: unknown }; children: (d: unknown) => React.ReactNode }) => children(query.data) }))

import { ApiError } from "@/lib/api"
import AiCoach from "./AiCoach"

beforeEach(() => {
  vi.stubEnv("VITE_SMARTBOARD_ENGINE", "legacy")
  installDomStubs()
  window.matchMedia = ((q: string) => ({ matches: h.wide && q.includes("1024"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
  if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) }, configurable: true })
  h.send.mockReset(); h.refetch.mockReset(); h.wide = true; localStorage.clear()
})
afterEach(() => { cleanup(); vi.unstubAllEnvs() })

const mount = () => render(
  <MemoryRouter initialEntries={["/student/courses/C1/assignments/A1/coach"]}>
    <Routes><Route path="/student/courses/:courseId/assignments/:assignmentId/coach" element={<AiCoach />} /></Routes>
  </MemoryRouter>,
)
const say = (text: string) => {
  fireEvent.change(screen.getByLabelText("Message SocratiQ AI"), { target: { value: text } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
}
const hidden = (el: Element | null) => !!el?.closest(".hidden")
const final = (content: string, id = "m1") => ({ interactionId: "i1", turn: 1, sources: [], message: { id, role: "coach", content } })

describe("wide screen: one workspace", () => {
  it("shows conversation and board together, with a splitter and panel controls instead of tabs", () => {
    mount()
    expect(screen.queryByRole("tablist")).toBeNull()
    expect(screen.getByRole("separator")).toBeTruthy()
    expect(hidden(screen.getByText(/Tell SocratiQ where you're stuck/))).toBe(false)
    expect(hidden(screen.getByRole("toolbar", { hidden: true }))).toBe(false)               // the board's tools are on screen at the same time
    expect(screen.getByPlaceholderText(/Ask SocratiQ, or about what's on the board/)).toBeTruthy()
  })

  it("collapsing a panel hides it without unmounting it, and 'show both' restores the split", () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Expand Board" }))
    expect(hidden(screen.getByText(/Tell SocratiQ where you're stuck/))).toBe(true)
    expect(hidden(screen.getByRole("toolbar", { hidden: true }))).toBe(false)
    expect(screen.queryByRole("separator")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Show both panels" }))
    expect(screen.getByRole("separator")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Expand Conversation" }))
    expect(hidden(screen.getByRole("toolbar", { hidden: true }))).toBe(true)
    expect(hidden(screen.getByText(/Tell SocratiQ where you're stuck/))).toBe(false)
  })

  it("below 1024px the original Chat / Whiteboard tabs apply", () => {
    h.wide = false
    mount()
    expect(screen.getByRole("tab", { name: "Chat" })).toBeTruthy()
    expect(screen.queryByRole("separator")).toBeNull()
  })

  it("an ordinary message goes out as chat; the same Coach and the same key discipline apply", async () => {
    h.send.mockResolvedValue(final("ok"))
    mount()
    say("is my update right?")
    await waitFor(() => expect(h.send).toHaveBeenCalled())
    const v = h.send.mock.calls[0][0]
    expect(v).toMatchObject({ assignmentId: "A1", message: "is my update right?", mode: "chat" })
    expect(typeof v.clientTurnId).toBe("string")
    expect(v.clientTurnId.length).toBeGreaterThanOrEqual(8)
  })
})

describe("progressive reply", () => {
  it("renders approved segments as they arrive, then replaces them with the canonical reply once (no duplicate)", async () => {
    let deltas!: (t: string) => void
    let finish!: (v: unknown) => void
    h.send.mockImplementation((_v, _stage, _sig, onDelta) => { deltas = onDelta; return new Promise((r) => { finish = r }) })
    mount()
    say("explain")
    await waitFor(() => expect(typeof deltas).toBe("function"))
    expect(screen.queryByText(/Hel/)).toBeNull()
    act(() => deltas("Hel"))
    expect(screen.getByText("Hel")).toBeTruthy()
    act(() => deltas("lo there"))
    expect(screen.getByText("Hello there")).toBeTruthy()
    await act(async () => finish(final("Hello there")))
    expect(screen.getAllByText("Hello there")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy()                // the composer is back to "send"
  })

  it("keeps Arabic and code text exactly as streamed", async () => {
    let deltas!: (t: string) => void
    let finish!: (v: unknown) => void
    h.send.mockImplementation((_v, _s, _g, onDelta) => { deltas = onDelta; return new Promise((r) => { finish = r }) })
    mount()
    say("اشرح")
    await waitFor(() => expect(deltas).toBeTruthy())
    act(() => { deltas("معدل التعلّم "); deltas("هو الخطوة") })
    expect(screen.getByText("معدل التعلّم هو الخطوة")).toBeTruthy()
    await act(async () => finish(final("معدل التعلّم هو الخطوة")))
    expect(screen.getAllByText("معدل التعلّم هو الخطوة")).toHaveLength(1)
  })
})

describe("retry and idempotency", () => {
  it("retrying the SAME message reuses its key; a different message gets a new one", async () => {
    h.send.mockRejectedValueOnce(new ApiError(0, "Can't reach the server.", "network")).mockResolvedValue(final("ok"))
    mount()
    say("first")
    await waitFor(() => screen.getByRole("button", { name: "Retry" }))
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(2))
    expect(h.send.mock.calls[1][0].clientTurnId).toBe(h.send.mock.calls[0][0].clientTurnId)
    await waitFor(() => screen.getByRole("button", { name: "Send message" }))
    say("second")
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(3))
    expect(h.send.mock.calls[2][0].clientTurnId).not.toBe(h.send.mock.calls[0][0].clientTurnId)
  })

  it("editing the message after a failure does not reuse the old key", async () => {
    h.send.mockRejectedValueOnce(new ApiError(0, "Can't reach the server.", "network")).mockResolvedValue(final("ok"))
    mount()
    say("original")
    await waitFor(() => screen.getByRole("button", { name: "Retry" }))
    say("edited")
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(2))
    expect(h.send.mock.calls[1][0].clientTurnId).not.toBe(h.send.mock.calls[0][0].clientTurnId)
  })

  it("a drop after the text started arriving shows what the server stored and does not offer to resend", async () => {
    h.send.mockImplementation(async (_v, _s, _g, onDelta) => { onDelta("Partial rep"); throw new ApiError(0, "dropped", "network_after_save") })
    h.refetch.mockResolvedValue({ data: [{ id: "u1", role: "student", content: "explain" }, { id: "c1", role: "coach", content: "Partial reply, complete." }] })
    mount()
    say("explain")
    await waitFor(() => expect(screen.getByText("Partial reply, complete.")).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.getByRole("alert").textContent).toMatch(/were saved/)
    expect(screen.queryByText("Partial rep")).toBeNull()
  })

  it("a failure before any text still removes the unsent message and offers retry", async () => {
    h.send.mockRejectedValue(new ApiError(503, "down", "ai_unavailable"))
    mount()
    say("hello")
    await waitFor(() => screen.getByRole("button", { name: "Retry" }))
    expect(screen.queryByText("hello", { selector: "p, div" })).toBeNull()
    expect(screen.getByRole("alert").textContent).toMatch(/wasn't saved/)
  })
})

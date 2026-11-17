// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { forwardRef, useImperativeHandle } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installDomStubs } from "@/test/domStubs"

const h = vi.hoisted(() => ({
  send: vi.fn(),
  run: vi.fn(async (..._a: unknown[]) => true),
  canShow: true,
  board: { steps: [] as string[], strokes: [] as unknown[], elements: [] as unknown[], nextSeq: 0 },
}))

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
vi.mock("@/lib/queries", () => ({
  sendCoachStream: (...a: unknown[]) => h.send(...a),
  saveWhiteboard: async () => ({}),
  useCoachHistory: () => ({ data: [], isPending: false }),
  useStartAttempt: () => ({ mutate: vi.fn() }),
  useStudentAssignment: () => ({ data: { id: "A1", title: "Gradient descent", topic: "Gradient descent", dueDate: "2099-01-01T00:00:00Z", status: "in_progress" } }),
  useStudentCourse: () => ({ data: { course: { name: "CS101" } } }),
  usePersonas: () => ({ data: undefined }),          // the persona selector renders nothing without data; it has its own tests
  useSetPersona: () => ({ mutate: vi.fn() }),
  useWhiteboard: () => ({ data: h.board, isError: false }),
}))
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock("@/components/ui/States", () => ({ QueryState: ({ query, children }: { query: { data: unknown }; children: (d: unknown) => React.ReactNode }) => children(query.data) }))
// A stand-in for the native board: exactly the BoardApi surface the page uses, with `runCoachVisual` as a spy.
vi.mock("@/components/smartboard/BoardSurface", () => ({
  BoardSurface: forwardRef(function Fake(_p: unknown, ref) {
    useImperativeHandle(ref, () => ({ flush: async () => true, applyServer: () => 0, selectedId: () => null, ...(h.canShow ? { runCoachVisual: (v: unknown) => h.run(v) } : {}) }))
    return <div data-testid="board" />
  }),
}))

import AiCoach from "./AiCoach"

const VISUAL = { grant: "vgr_1.9999999999.sig", kind: "simulation", request: "How step size changes the loss", why: "See the effect", explorePrompt: "Move the slider. What changes?", concept: "learning rate", interactionId: "i1" }
const reply = (over = {}) => ({ interactionId: "i1", turn: 1, sources: [], message: { id: "m1", role: "coach", content: "I put a simulation on your board. Move the slider." }, ...over })

beforeEach(() => {
  installDomStubs()
  if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => Math.random().toString(36).slice(2) }, configurable: true })
  h.send.mockReset(); h.run.mockReset(); h.run.mockImplementation(async () => true); h.canShow = true
})
afterEach(() => cleanup())

const mount = () => render(
  <MemoryRouter initialEntries={["/student/courses/C1/assignments/A1/coach"]}>
    <Routes><Route path="/student/courses/:courseId/assignments/:assignmentId/coach" element={<AiCoach />} /></Routes>
  </MemoryRouter>,
)
const say = (t: string) => { fireEvent.change(screen.getByLabelText("Message SocratiQ AI"), { target: { value: t } }); fireEvent.click(screen.getByRole("button", { name: "Send message" })) }

describe("a visual the Coach decided on", () => {
  it("tells the server this page can show one, only when the board really can", async () => {
    h.send.mockResolvedValue(reply()); mount(); say("hi")
    await waitFor(() => expect(h.send).toHaveBeenCalled())
    expect((h.send.mock.calls[0][0] as { visuals?: boolean }).visuals).toBe(true)
    cleanup(); h.send.mockClear(); h.canShow = false; h.send.mockResolvedValue(reply()); mount(); say("hi")
    await waitFor(() => expect(h.send).toHaveBeenCalled())
    expect((h.send.mock.calls[0][0] as { visuals?: boolean }).visuals).toBe(false)         // e.g. the legacy engine: the Coach is never offered the option
  })

  it("is drawn right away, with the server's grant, when the student is on the whiteboard", async () => {
    h.send.mockResolvedValue(reply({ visual: VISUAL })); mount()
    fireEvent.click(screen.getByRole("tab", { name: "Whiteboard" })); say("I don't get the learning rate")
    await waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    expect(h.run.mock.calls[0][0]).toMatchObject({ grant: VISUAL.grant, kind: "simulation" })
    expect(await screen.findByText(/SocratiQ added a simulation to your board/)).toBeTruthy()
  })

  it("waits for the board when the student is in Chat, says so, and draws it when they open the board", async () => {
    h.send.mockResolvedValue(reply({ visual: VISUAL })); mount(); say("I don't get the learning rate")
    expect(await screen.findByText(/SocratiQ prepared a simulation for your board/)).toBeTruthy()
    expect(h.run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("tab", { name: "Whiteboard" }))
    await waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/SocratiQ added a simulation to your board/)).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Chat" })); fireEvent.click(screen.getByRole("tab", { name: "Whiteboard" }))
    expect(h.run).toHaveBeenCalledTimes(1)                                                  // never drawn twice
  })

  it("a visual that cannot be drawn is said honestly and the conversation carries on", async () => {
    h.run.mockImplementation(async () => false)
    h.send.mockResolvedValue(reply({ visual: VISUAL })); mount()
    fireEvent.click(screen.getByRole("tab", { name: "Whiteboard" })); say("help")
    expect(await screen.findByText(/couldn't be drawn this time/)).toBeTruthy()
  })

  it("nothing is drawn when the Coach did not decide on a visual", async () => {
    h.send.mockResolvedValue(reply()); mount()
    fireEvent.click(screen.getByRole("tab", { name: "Whiteboard" })); say("help")
    await waitFor(() => expect(h.send).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(h.run).not.toHaveBeenCalled()
  })
})

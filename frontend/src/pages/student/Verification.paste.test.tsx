// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const TYPES = ["EXPLAIN", "MODIFY", "TRANSFER"] as const
const MESSAGE = "Please write your answer in your own words instead of pasting text."

const stateAt = (i: number) => ({
  verificationId: "V1", status: "IN_PROGRESS", outcome: null, needsQuestion: false,
  steps: TYPES.map((type, j) => ({ type, status: j < i ? "done" : j === i ? "current" : "upcoming" })),
  current: { questionId: `q${i}`, type: TYPES[i], question: `Question ${i + 1} about the lesson?`, index: i },
})
const completed = {
  verificationId: "V1", status: "COMPLETED", outcome: "PASS", needsQuestion: false,
  steps: TYPES.map((type) => ({ type, status: "done" })), current: null,
}

const h = vi.hoisted(() => ({ start: vi.fn(), answer: vi.fn() }))

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
vi.mock("@/lib/queries", () => ({
  useStartVerification: () => ({ mutateAsync: h.start, isPending: false }),
  useAnswerVerification: () => ({ mutateAsync: h.answer, isPending: false }),
  useStudentAssignment: () => ({ data: { id: "A1", title: "Kidney anatomy" } }),
  useStudentCourse: () => ({ data: { course: { name: "Biology" } } }),
}))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }))
vi.mock("@/lib/celebrate", () => ({ celebrateVerification: vi.fn() }))
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

import Verification from "./Verification"

beforeEach(() => {
  h.start.mockReset().mockResolvedValue(stateAt(0))
  let step = 0
  h.answer.mockReset().mockImplementation(async () => {
    step += 1
    return { result: { outcome: "PASS", feedback: "Good reasoning.", criteria: [] }, completed: step >= 3, state: step >= 3 ? completed : stateAt(step) }
  })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = () => render(
  <MemoryRouter initialEntries={["/student/courses/C1/assignments/A1/verification"]}>
    <Routes><Route path="/student/courses/:courseId/assignments/:assignmentId/verification" element={<Verification />} /></Routes>
  </MemoryRouter>,
)
const field = () => screen.getByLabelText("Your response") as HTMLTextAreaElement
const notice = () => document.getElementById("verification-paste-notice")!
const clip = (text = "text copied from a website") => ({ clipboardData: { getData: () => text, types: ["text/plain"] } })
const nativeBeforeInput = (el: Element, inputType: string) => {
  const ev = new Event("beforeinput", { bubbles: true, cancelable: true })
  Object.defineProperty(ev, "inputType", { value: inputType })
  return el.dispatchEvent(ev)          // false = default prevented
}

/** Every paste path is blocked, the message appears, and the answer is unchanged. */
function expectPasteBlocked(el: HTMLTextAreaElement) {
  const before = el.value
  expect(fireEvent.paste(el, clip())).toBe(false)                                             // right-click / menu / any paste event
  expect(notice().textContent).toBe(MESSAGE)
  expect(fireEvent.keyDown(el, { key: "v", code: "KeyV", ctrlKey: true })).toBe(false)        // Ctrl+V
  expect(fireEvent.keyDown(el, { key: "v", code: "KeyV", metaKey: true })).toBe(false)        // Cmd+V
  expect(fireEvent.keyDown(el, { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true })).toBe(false)
  expect(fireEvent.keyDown(el, { key: "Insert", shiftKey: true })).toBe(false)                // Shift+Insert
  expect(nativeBeforeInput(el, "insertFromPaste")).toBe(false)                                // mobile clipboard / IME paste
  expect(fireEvent.drop(el, { dataTransfer: { types: ["text/plain"], getData: () => "dragged in" } })).toBe(false)
  expect(el.value).toBe(before)
}

/** Typing, editing, selection, copy/cut, undo and navigation keep their default behaviour. */
function expectEditingWorks(el: HTMLTextAreaElement, text: string) {
  fireEvent.change(el, { target: { value: text } })
  expect(el.value).toBe(text)
  for (const key of [
    { key: "a", ctrlKey: true }, { key: "a", metaKey: true }, { key: "c", ctrlKey: true }, { key: "c", metaKey: true },
    { key: "x", ctrlKey: true }, { key: "z", ctrlKey: true }, { key: "y", ctrlKey: true }, { key: "z", metaKey: true, shiftKey: true },
    { key: "Backspace" }, { key: "Delete" }, { key: "ArrowLeft" }, { key: "ArrowRight", shiftKey: true }, { key: "Home" }, { key: "End" },
    { key: "ArrowUp" }, { key: "Enter" }, { key: "Tab" }, { key: "v" }, { key: "v", ctrlKey: true, altKey: true },
  ]) expect(fireEvent.keyDown(el, key), JSON.stringify(key)).toBe(true)
  expect(nativeBeforeInput(el, "insertText")).toBe(true)
  expect(nativeBeforeInput(el, "deleteContentBackward")).toBe(true)
  expect(fireEvent.copy(el)).toBe(true)
  expect(fireEvent.cut(el)).toBe(true)
  el.setSelectionRange(0, 3)
  expect([el.selectionStart, el.selectionEnd]).toEqual([0, 3])
  fireEvent.change(el, { target: { value: text.slice(0, -1) } })                               // deleting still updates the answer
  expect(el.value).toBe(text.slice(0, -1))
  fireEvent.change(el, { target: { value: text } })
}

describe("Verification answer field: paste is blocked in all three comprehension answers", () => {
  it("blocks every paste path while typing and editing work, for Explain, Modify and Transfer", async () => {
    mount()
    for (let i = 0; i < 3; i++) {
      await screen.findByText(`Question ${i + 1} about the lesson?`)
      const el = field()
      expect(el.getAttribute("data-paste-guard")).toBe("verification")
      expectPasteBlocked(el)
      expect(el.getAttribute("aria-describedby")).toContain("verification-paste-notice")
      const mine = `My own explanation for step ${i + 1}`
      expectEditingWorks(el, mine)
      fireEvent.click(screen.getByRole("button", { name: i < 2 ? "Continue" : "Finish verification" }))
      await waitFor(() => expect(h.answer).toHaveBeenCalledTimes(i + 1))
      expect(h.answer.mock.calls[i][0]).toEqual({ verificationId: "V1", answer: mine })   // the typed answer is what gets submitted
      if (i < 2) await waitFor(() => expect(notice().textContent).toBe(""))               // the notice resets for the next question
    }
    await screen.findByText("Verification complete")
  })

  it("does not change the answer or submit anything when a paste is attempted", async () => {
    mount()
    const el = await waitFor(field)
    fireEvent.change(el, { target: { value: "partial answer" } })
    fireEvent.paste(el, clip("A full answer copied from somewhere else"))
    expect(el.value).toBe("partial answer")
    expect(h.answer).not.toHaveBeenCalled()
  })

  it("shows the message subtly and hides it again after a few seconds", async () => {
    mount()
    const el = await waitFor(field)
    expect(notice().getAttribute("role")).toBe("status")
    expect(notice().textContent).toBe("")
    vi.useFakeTimers()
    fireEvent.paste(el, clip())
    expect(notice().textContent).toBe(MESSAGE)
    expect(screen.queryByRole("alert")).toBeNull()                                              // not an error, not a modal
    act(() => { vi.advanceTimersByTime(4100) })
    expect(notice().textContent).toBe("")
    expect(el.getAttribute("aria-describedby")).toBe("verification-question")
  })

  it("still lets the student drag their own selected text within the field", async () => {
    mount()
    const el = await waitFor(field)
    fireEvent.change(el, { target: { value: "move these words" } })
    fireEvent.dragStart(el)
    expect(nativeBeforeInput(el, "insertFromDrop")).toBe(true)
    expect(fireEvent.drop(el, { dataTransfer: { types: ["text/plain"], getData: () => "these" } })).toBe(true)
    fireEvent.dragEnd(el)
    expect(fireEvent.drop(el, { dataTransfer: { types: ["text/plain"], getData: () => "from outside" } })).toBe(false)
  })
})

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ isConfigured: true, supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { ApiError } from "@/lib/api"
import { notesPanel, NotesSync, type Note, type NotesApi } from "@/lib/notes"
import NotesDrawer from "./NotesDrawer"

function server(initial: Note[] = []) {
  const db = new Map(initial.map((n) => [n.id, { ...n }]))
  let failCreate = 0
  const api: NotesApi = {
    list: vi.fn(async (q?: string) => [...db.values()]
      .filter((n) => !q || (n.title + n.content).toLowerCase().includes(q.toLowerCase()))
      .map((n) => ({ ...n, preview: n.content.slice(0, 240) }))),
    get: vi.fn(async (id: string) => {
      const n = db.get(id)
      if (!n) throw new ApiError(404, "Note not found.", "not_found")
      return { ...n }
    }),
    create: vi.fn(async (b) => {
      if (failCreate > 0) { failCreate--; throw new ApiError(0, "network", "network") }
      const n = { id: b.id, title: b.title, content: b.content, version: 1, createdAt: "2026-11-20T10:00:00Z", updatedAt: new Date().toISOString() }
      if (!db.has(b.id)) db.set(b.id, n)
      return { ...db.get(b.id)! }
    }),
    update: vi.fn(async (id: string, b) => {
      const n = db.get(id)!
      Object.assign(n, { title: b.title, content: b.content, version: n.version + 1, updatedAt: new Date().toISOString() })
      return { ...n }
    }),
    remove: vi.fn(async (id: string) => { db.delete(id) }),
  }
  return { api, db, failNextCreates: (n: number) => { failCreate = n } }
}

const NOTE = (id: string, title: string, content: string, updatedAt = "2026-11-20T09:00:00Z"): Note =>
  ({ id: `note_${id.padEnd(32, "0")}`, title, content, version: 1, createdAt: updatedAt, updatedAt })

let sync: NotesSync
beforeEach(() => { notesPanel.set({ open: true, noteId: null }) })
afterEach(() => { cleanup(); notesPanel.set({ open: false, noteId: null }) })

const mount = (api: NotesApi, onClose = vi.fn(), retryMs = 30) => {
  sync = new NotesSync(api, { debounceMs: 20, retryDelaysMs: [retryMs] })
  render(<NotesDrawer client={api} sync={sync} onClose={onClose} />)
  return onClose
}

describe("My Notes panel", () => {
  it("shows a clean empty state with a way to start", async () => {
    mount(server().api)
    expect(await screen.findByText("No notes yet")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /new note/i }).length).toBeGreaterThan(0)
    expect(screen.getByRole("complementary", { name: "My notes" })).toBeTruthy()
  })

  it("creates a note, auto-saves it and only then says Saved", async () => {
    const s = server()
    mount(s.api)
    await screen.findByText("No notes yet")
    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0])
    const title = await screen.findByPlaceholderText("Title")
    fireEvent.change(title, { target: { value: "Recursion" } })
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "A function that calls itself." } })
    expect(screen.getByRole("status").textContent).toContain("Saving")
    expect(screen.queryByText("Saved")).toBeNull()
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved"))
    expect([...s.db.values()]).toMatchObject([{ title: "Recursion", content: "A function that calls itself." }])
    expect(s.api.create).toHaveBeenCalledTimes(1)
  })

  it("shows Save failed on a network error, then recovers by itself without making a duplicate", async () => {
    const s = server()
    s.failNextCreates(1)
    mount(s.api, vi.fn(), 400)
    await screen.findByText("No notes yet")
    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0])
    fireEvent.change(await screen.findByLabelText("Note"), { target: { value: "offline thought" } })
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Save failed"))
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved"))
    expect(s.db.size).toBe(1)
    const ids = (s.api.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].id)
    expect(new Set(ids).size).toBe(1)
  })

  it("lists notes newest first, opens one, and searches", async () => {
    const s = server([NOTE("a", "Loops", "for i in range(3)", "2026-11-19T10:00:00Z"), NOTE("b", "Recursion", "base case", "2026-11-20T10:00:00Z")])
    mount(s.api)
    const list = await screen.findByRole("list", { name: "Notes" })
    const rows = within(list).getAllByRole("button")
    expect(rows[0].textContent).toContain("Recursion")
    expect(rows[1].textContent).toContain("Loops")
    fireEvent.change(screen.getByPlaceholderText("Search notes"), { target: { value: "range" } })
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Notes" })).getAllByRole("button")).toHaveLength(1))
    fireEvent.click(screen.getByText("Loops"))
    expect(await screen.findByDisplayValue("for i in range(3)")).toBeTruthy()
  })

  it("asks before deleting and deletes only after confirmation", async () => {
    const s = server([NOTE("a", "Keep?", "x")])
    mount(s.api)
    fireEvent.click(await screen.findByText("Keep?"))
    await screen.findByDisplayValue("Keep?")
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    expect(s.api.remove).not.toHaveBeenCalled()
    const dialog = screen.getByRole("alertdialog", { name: "Delete this note?" })
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(s.db.size).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" })) })
    await waitFor(() => expect(s.db.size).toBe(0))
    expect(await screen.findByText("No notes yet")).toBeTruthy()
  })

  it("closing with an unsaved edit still saves it", async () => {
    const s = server([NOTE("a", "Draft", "v1")])
    const onClose = mount(s.api)
    fireEvent.click(await screen.findByText("Draft"))
    fireEvent.change(await screen.findByLabelText("Note"), { target: { value: "v2 typed just before closing" } })
    fireEvent.click(screen.getByRole("button", { name: "Close notes" }))
    expect(onClose).toHaveBeenCalled()
    await waitFor(() => expect([...s.db.values()][0].content).toBe("v2 typed just before closing"))
  })

  it("Escape closes the panel", async () => {
    const onClose = mount(server().api)
    await screen.findByText("No notes yet")
    fireEvent.keyDown(screen.getByRole("complementary", { name: "My notes" }), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("renders formatted Markdown in preview without turning HTML into elements", async () => {
    const s = server([NOTE("a", "Fmt", "## Title\n\n**bold** <img src=x onerror=alert(1)>")])
    mount(s.api)
    fireEvent.click(await screen.findByText("Fmt"))
    await screen.findByDisplayValue("Fmt")
    fireEvent.click(screen.getByRole("button", { name: /preview/i }))
    const h = await screen.findByRole("heading", { name: "Title" })
    expect(h.tagName).toBe("H2")
    expect(screen.getByText("bold").tagName).toBe("STRONG")
    expect(document.querySelector("img")).toBeNull()
  })

  it("shows a retryable error when the list cannot load", async () => {
    const s = server()
    ;(s.api.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(0, "Can't reach the server.", "network"))
    mount(s.api)
    expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server.")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByText("No notes yet")).toBeTruthy()
  })
})

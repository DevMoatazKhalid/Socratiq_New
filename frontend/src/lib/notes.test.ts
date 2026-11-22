import { describe, expect, it, vi } from "vitest"

vi.mock("./supabase", () => ({ isConfigured: true, supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
import { ApiError } from "./api"
import { NotesSync, saveCoachReply, titleFrom, type Note, type NotesApi } from "./notes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** An in-memory server with the API's real semantics: idempotent create by id, optimistic versions, same-text retry answered as saved. */
function fakeServer({ failTimes = 0, delay = 15 }: { failTimes?: number; delay?: number } = {}) {
  const db = new Map<string, Note>()
  const calls: [string, string, string][] = []
  let fails = failTimes
  const api: NotesApi = {
    list: async () => [...db.values()].map((n) => ({ ...n, preview: n.content })),
    get: async (id) => {
      const n = db.get(id)
      if (!n) throw new ApiError(404, "Note not found.", "not_found")
      return { ...n }
    },
    create: async (b) => {
      calls.push(["create", b.id, b.content])
      await sleep(delay)
      if (fails > 0) { fails--; throw new ApiError(0, "network", "network") }
      if (!db.has(b.id)) db.set(b.id, { id: b.id, title: b.title, content: b.content, version: 1, createdAt: "c", updatedAt: "u" })
      return { ...db.get(b.id)! }
    },
    update: async (id, b) => {
      calls.push(["update", id, b.content])
      await sleep(delay)
      if (fails > 0) { fails--; throw new ApiError(503, "unavailable") }
      const n = db.get(id)
      if (!n) throw new ApiError(404, "Note not found.", "not_found")
      if (n.version !== b.base_version) {
        if (n.content === b.content && n.title === b.title) return { ...n }
        throw new ApiError(409, "changed", "version_conflict")
      }
      Object.assign(n, { title: b.title, content: b.content, version: n.version + 1 })
      return { ...n }
    },
    remove: async (id) => { db.delete(id) },
  }
  return { api, db, calls }
}

describe("NotesSync auto-save", () => {
  it("debounces typing and shows Saved only after the server confirmed the text on screen", async () => {
    let onCreateStarted!: () => void
    const createStarted = new Promise<void>((r) => { onCreateStarted = r })
    let resolveCreate!: () => void
    const createHold = new Promise<void>((r) => { resolveCreate = r })

    let onUpdateStarted!: () => void
    const updateStarted = new Promise<void>((r) => { onUpdateStarted = r })
    let resolveUpdate!: () => void
    const updateHold = new Promise<void>((r) => { resolveUpdate = r })

    const { api, db, calls } = fakeServer({ delay: 0 })
    const origCreate = api.create
    api.create = async (b) => {
      onCreateStarted()
      await createHold
      return origCreate(b)
    }
    const origUpdate = api.update
    api.update = async (id, b) => {
      onUpdateStarted()
      await updateHold
      return origUpdate(id, b)
    }

    const s = new NotesSync(api, { debounceMs: 10 })
    const d = s.createLocal()
    expect(calls).toHaveLength(0)                                   // an empty new note is not created on the server
    s.edit(d.id, { content: "a" })
    s.edit(d.id, { content: "ab" })
    expect(s.draft(d.id)!.state).toBe("pending")
    await createStarted
    expect(s.draft(d.id)!.state).toBe("saving")
    s.edit(d.id, { content: "abc" })                                // typed while the first save is in flight
    resolveCreate()
    await updateStarted                                             // second save begins for the new text
    expect(s.draft(d.id)!.state).not.toBe("saved")                  // the confirmed text ("ab") is not what the student sees
    resolveUpdate()
    await s.flush(d.id)
    expect(s.draft(d.id)!.state).toBe("saved")
    expect(db.get(d.id)!.content).toBe("abc")
    expect(calls.map((c) => c[0])).toEqual(["create", "update"])     // coalesced: never one request per keystroke, never two in parallel
  })

  it("retries after a network failure with the SAME note id, so a retry can never create a duplicate", async () => {
    const { api, db, calls } = fakeServer({ failTimes: 2 })
    const s = new NotesSync(api, { debounceMs: 5, retryDelaysMs: [15] })
    const d = s.createLocal()
    s.edit(d.id, { content: "x" })
    await sleep(30)
    expect(["error", "saving"]).toContain(s.draft(d.id)!.state)
    await sleep(150)
    expect(s.draft(d.id)!.state).toBe("saved")
    expect(db.size).toBe(1)
    expect(new Set(calls.map((c) => c[1])).size).toBe(1)
    expect(calls).toHaveLength(3)
  })

  it("reports Save failed for a permanent error and does not retry it", async () => {
    const s = new NotesSync({ ...fakeServer().api, create: async () => { throw new ApiError(422, "The request is not valid.", "validation_error") } }, { debounceMs: 5, retryDelaysMs: [5] })
    const d = s.createLocal()
    s.edit(d.id, { content: "x" })
    await sleep(40)
    expect(s.draft(d.id)!.state).toBe("error")
    expect(s.draft(d.id)!.error).toBe("The request is not valid.")
    expect(s.hasUnsaved()).toBe(true)
  })

  it("flush (closing the panel) sends a pending edit immediately and resolves once it is saved", async () => {
    const { api, db } = fakeServer()
    const s = new NotesSync(api, { debounceMs: 60_000 })
    const d = s.createLocal()
    s.edit(d.id, { content: "typed right before closing" })
    await s.flushAll()
    expect(db.get(d.id)!.content).toBe("typed right before closing")
    expect(s.hasUnsaved()).toBe(false)
  })

  it("never overwrites an edit made in another tab: it becomes a conflict the student resolves", async () => {
    const { api, db } = fakeServer()
    const s = new NotesSync(api, { debounceMs: 5 })
    const d = s.createLocal()
    s.edit(d.id, { content: "v1" })
    await s.flush(d.id)
    Object.assign(db.get(d.id)!, { content: "from the other tab", version: 7 })
    s.edit(d.id, { content: "mine" })
    await sleep(50)
    expect(s.draft(d.id)!.state).toBe("conflict")
    expect(db.get(d.id)!.content).toBe("from the other tab")
    await s.keepMine(d.id)
    expect(db.get(d.id)).toMatchObject({ content: "mine", version: 8 })
    expect(s.draft(d.id)!.state).toBe("saved")

    Object.assign(db.get(d.id)!, { content: "newer elsewhere", version: 9 })
    s.edit(d.id, { content: "discard me" })
    await sleep(50)
    await s.useSaved(d.id)
    expect(s.draft(d.id)).toMatchObject({ state: "saved", content: "newer elsewhere" })
  })

  it("keeps the text when the note was deleted elsewhere and can save it as a new note", async () => {
    const { api, db } = fakeServer()
    const s = new NotesSync(api, { debounceMs: 5 })
    const d = s.createLocal()
    s.edit(d.id, { content: "v1" })
    await s.flush(d.id)
    db.delete(d.id)
    s.edit(d.id, { content: "still mine" })
    await sleep(50)
    expect(s.draft(d.id)!.state).toBe("deleted_elsewhere")
    const n = s.saveAsNew(d.id)!
    await s.flush(n.id)
    expect(db.get(n.id)!.content).toBe("still mine")
  })

  it("adopting a refetched note never replaces unsaved local text", async () => {
    const { api } = fakeServer()
    const s = new NotesSync(api, { debounceMs: 60_000 })
    const d = s.createLocal()
    s.edit(d.id, { content: "unsaved" })
    s.adopt({ id: d.id, title: "", content: "server copy", version: 3, createdAt: "c", updatedAt: "u" })
    expect(s.draft(d.id)!.content).toBe("unsaved")
  })

  it("delete removes the note on the server and forgets the draft", async () => {
    const { api, db } = fakeServer()
    const s = new NotesSync(api, { debounceMs: 5 })
    const d = s.createLocal()
    s.edit(d.id, { content: "bye" })
    await s.flush(d.id)
    await s.remove(d.id)
    expect(db.has(d.id)).toBe(false)
    expect(s.draft(d.id)).toBeUndefined()
  })
})

describe("Save to Notes", () => {
  it("a double click sends one request and both get the same note", async () => {
    const { api } = fakeServer()
    let n = 0
    const counting: NotesApi = { ...api, create: async (b) => { n++; return api.create(b) } }
    const [a, b] = await Promise.all([saveCoachReply("msg_1", "t", "c", counting), saveCoachReply("msg_1", "t", "c", counting)])
    expect(a.id).toBe(b.id)
    expect(n).toBe(1)
  })

  it("titles come from the first meaningful line", () => {
    expect(titleFrom("## Gradient descent\nmore")).toBe("Gradient descent")
    expect(titleFrom("```py\nx = 1\n```")).toBe("py")
    expect(titleFrom("   ")).toBe("Untitled note")
  })
})

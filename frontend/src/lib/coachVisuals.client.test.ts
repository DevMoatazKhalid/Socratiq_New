import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))
const apiStream = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({})))
vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), apiStream: (...a: unknown[]) => apiStream(...a) }))
import { ApiError } from "./api"
import { generateDiagram, generateSimulation, sendCoachStream } from "./queries"
import { describeAiError } from "./smartboard/glue"

const ok = () => vi.fn(async () => new Response(JSON.stringify({ code: "<x/>", spec: {}, attempts: 1 }), { status: 200, headers: { "content-type": "application/json" } }))
beforeEach(() => apiStream.mockClear())
afterEach(() => vi.restoreAllMocks())

describe("Coach visuals on the wire", () => {
  it("the Coach request says the page can show a visual only when asked to", async () => {
    await sendCoachStream({ assignmentId: "A1", message: "hi", visuals: true }, () => {})
    await sendCoachStream({ assignmentId: "A1", message: "hi" }, () => {})
    expect((apiStream.mock.calls[0][1] as Record<string, unknown>).visuals).toBe(true)
    expect("visuals" in (apiStream.mock.calls[1][1] as Record<string, unknown>)).toBe(false)
  })
  it("redeeming sends the grant, and a normal request sends none", async () => {
    const f = ok(); vi.stubGlobal("fetch", f)
    await generateSimulation("p", undefined, "A1", "vgr_1.99.sig")
    await generateSimulation("p", undefined, "A1")
    await generateDiagram({ request: "r", board: [], assignmentId: "A1", grant: "vgr_2.99.sig" })
    const bodies = f.mock.calls.map((c) => JSON.parse((c as unknown as [string, { body: string }])[1].body))
    expect(bodies[0].grant).toBe("vgr_1.99.sig")
    expect("grant" in bodies[1]).toBe(false)
    expect(bodies[2].grant).toBe("vgr_2.99.sig")
  })
  it("grant problems are explained in plain words", () => {
    expect(describeAiError(new ApiError(410, "x", "visual_grant_expired"))).toMatch(/expired/)
    expect(describeAiError(new ApiError(409, "x", "visual_grant_used"))).toMatch(/already on your board/)
    expect(describeAiError(new ApiError(403, "x", "visual_grant_invalid"))).toMatch(/isn't available/)
  })
})

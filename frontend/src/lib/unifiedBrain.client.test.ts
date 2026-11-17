import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api")
  return { ...actual, apiBase: () => "http://api.test/api/v1", accessToken: async () => "tok" }
})
import { ApiError } from "./api"
import { CoachRedirectError, generateImageContent, generateSimulationCode, generateVectorDrawing } from "./geminiSmartBoardService"
import { describeAiError } from "./smartboard/glue"

const REDIRECT = "I won't draw the finished solution. What have you tried so far?"
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
const redirect = () => reply(422, { error: { status: 422, code: "coach_redirect", message: REDIRECT } })
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe("every board AI call tells the server which assignment it belongs to", () => {
  it.each([
    ["image", (c: any) => generateImageContent("a cat", "1K", c)],
    ["simulation", (c: any) => generateSimulationCode("waves", c)],
    ["vector", (c: any) => generateVectorDrawing("a square", c)],
  ])("%s sends assignment_id so the assignment's policy applies", async (_n, call) => {
    const f = reply(200, { imageUrl: "data:image/png;base64,AAAA", code: "<x/>", elements: [{ type: "rect" }] }); vi.stubGlobal("fetch", f)
    await call({ assignmentId: "A1" })
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).assignment_id).toBe("A1")
  })
  it("sends nothing extra when there is no assignment", async () => {
    const f = reply(200, { code: "<x/>" }); vi.stubGlobal("fetch", f)
    await generateSimulationCode("waves")
    expect(JSON.parse((f.mock.calls[0] as any)[1].body)).toEqual({ prompt: "waves" })
  })
})

describe("a Coach redirect is not a failure to hide", () => {
  it("is handed to Live tools (throwOnRedirect) with the Coach's own words", async () => {
    vi.stubGlobal("fetch", redirect())
    await expect(generateSimulationCode("final answer", { assignmentId: "A1", throwOnRedirect: true })).rejects.toThrowError(new CoachRedirectError(REDIRECT))
    await expect(generateImageContent("final answer", "1K", { throwOnRedirect: true })).rejects.toBeInstanceOf(CoachRedirectError)
    await expect(generateVectorDrawing("final answer", { throwOnRedirect: true })).rejects.toBeInstanceOf(CoachRedirectError)
  })
  it("stays a plain null for callers that did not ask (legacy board), like every other failure", async () => {
    vi.stubGlobal("fetch", redirect())
    expect(await generateSimulationCode("final answer", { assignmentId: "A1" })).toBeNull()
  })
  it("a different 422 is still just a failure, never mistaken for a redirect", async () => {
    vi.stubGlobal("fetch", reply(422, { error: { code: "bad_request", message: "x" } }))
    expect(await generateSimulationCode("p", { throwOnRedirect: true })).toBeNull()
  })
  it("the board UI shows the Coach's reply instead of the generic diagram failure", () => {
    expect(describeAiError(new ApiError(422, REDIRECT, "coach_redirect"))).toBe(REDIRECT)
    expect(describeAiError(new ApiError(422, "bad", "diagram_invalid"))).toMatch(/couldn't produce a clear diagram/)
  })
})

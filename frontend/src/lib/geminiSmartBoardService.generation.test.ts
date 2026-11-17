import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./api", () => ({ apiBase: () => "http://api.test/api/v1", accessToken: async () => "tok" }))
import { generateImageContent, generateSimulationCode, generateVectorDrawing } from "./geminiSmartBoardService"

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe("generation helpers never turn an error into a success", () => {
  it("send the bearer token", async () => {
    const f = reply(200, { imageUrl: "data:image/png;base64,AAAA" }); vi.stubGlobal("fetch", f)
    await generateImageContent("a cat")
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer tok")
  })
  it.each([401, 422, 429, 502, 504])("image: HTTP %s -> null", async (status) => {
    vi.stubGlobal("fetch", reply(status, { detail: "nope" }))
    expect(await generateImageContent("a cat")).toBeNull()
  })
  it("image: only a real data:image URL is accepted", async () => {
    vi.stubGlobal("fetch", reply(200, { imageUrl: "https://evil.example/x.png" })); expect(await generateImageContent("a")).toBeNull()
    vi.stubGlobal("fetch", reply(200, { imageUrl: "data:image/png;base64,AAAA" })); expect(await generateImageContent("a")).toBe("data:image/png;base64,AAAA")
  })
  it.each([401, 502])("simulation: HTTP %s -> null, and blank code -> null", async (status) => {
    vi.stubGlobal("fetch", reply(status, { detail: "x" })); expect(await generateSimulationCode("p")).toBeNull()
    vi.stubGlobal("fetch", reply(200, { code: "   " })); expect(await generateSimulationCode("p")).toBeNull()
    vi.stubGlobal("fetch", reply(200, { code: "<script>1</script>" })); expect(await generateSimulationCode("p")).toBe("<script>1</script>")
  })
  it.each([401, 502])("vector: HTTP %s is null, NOT an empty list of shapes", async (status) => {
    vi.stubGlobal("fetch", reply(status, { detail: "x" })); expect(await generateVectorDrawing("p")).toBeNull()
  })
  it("vector: an empty result is null; real shapes pass through", async () => {
    vi.stubGlobal("fetch", reply(200, { elements: [] })); expect(await generateVectorDrawing("p")).toBeNull()
    vi.stubGlobal("fetch", reply(200, { elements: [{ type: "rect" }] })); expect(await generateVectorDrawing("p")).toEqual([{ type: "rect" }])
  })
  it("a network failure is null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network") }))
    expect(await generateImageContent("a")).toBeNull(); expect(await generateVectorDrawing("a")).toBeNull(); expect(await generateSimulationCode("a")).toBeNull()
  })
})

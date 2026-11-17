// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const h = vi.hoisted(() => ({ tools: vi.fn(async (calls: any[]) => calls.map((c) => ({ id: c.id, response: { ok: true } }))) }))
vi.mock("@/lib/api", () => ({ accessToken: async () => "tok-123" }))
vi.mock("@/lib/geminiSmartBoardService", () => ({ getLiveWebSocketUrl: () => "ws://test/live" }))
vi.mock("@/lib/smartboard/liveToolHandler", () => ({ executeLiveTools: (...a: unknown[]) => h.tools(...(a as [any[]])) }))
vi.mock("@excalidraw/excalidraw", () => ({ exportToBlob: vi.fn(async () => new Blob(["x"], { type: "image/jpeg" })) }))

import { LiveVoicePanel, describeLiveClose } from "./LiveVoicePanel"

class FakeWS {
  static all: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  closeCalls = 0
  onopen: any = null; onmessage: any = null; onerror: any = null; onclose: any = null
  url: string
  constructor(url: string) { this.url = url; FakeWS.all.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closeCalls++; this.readyState = 3 }
  // test drivers
  open() { this.readyState = 1; return this.onopen?.() }
  msg(o: unknown) { return this.onmessage?.({ data: JSON.stringify(o) }) }
  serverClose(code: number, reason: string) { this.readyState = 3; this.onclose?.({ code, reason }) }
}

const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = []
let gum: ReturnType<typeof vi.fn>
let audioClosed = 0

beforeEach(() => {
  FakeWS.all = []; tracks.length = 0; audioClosed = 0; h.tools.mockClear()
  ;(globalThis as any).WebSocket = FakeWS
  gum = vi.fn(async () => { const t = { stop: vi.fn() }; tracks.push(t); return { getTracks: () => [t] } })
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: gum }, configurable: true })
  ;(globalThis as any).AudioContext = class {
    state = "running"; currentTime = 0; destination = {}
    createMediaStreamSource() { return { connect() {} } }
    createScriptProcessor() { return { connect() {}, onaudioprocess: null } }
    createBuffer() { return { getChannelData: () => new Float32Array(1), duration: 0.1 } }
    createBufferSource() { return { connect() {}, start() {}, stop() {}, buffer: null, onended: null } }
    createGain() { return { gain: { value: 0 }, connect() {} } }
    close() { audioClosed++ }
    resume() { return Promise.resolve() }
  }
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const api: any = { getSceneElements: () => [], getAppState: () => ({}), getFiles: () => ({}) }
const mount = (props: Partial<React.ComponentProps<typeof LiveVoicePanel>> = {}) =>
  render(<LiveVoicePanel api={api} assignmentId="A1" courseId="C1" onClose={props.onClose ?? (() => {})} {...props} />)
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

async function connect() {
  mount()
  const ws = FakeWS.all[0]
  await act(async () => { await ws.open() })
  return ws
}

describe("Live Voice: the UI only claims what is true", () => {
  it("says Connecting until the provider's setupComplete arrives, and does not touch the microphone before it", async () => {
    const ws = await connect()
    expect(screen.getByText(/Connecting to Gemini/)).toBeTruthy()
    expect(screen.queryByText(/Listening to you/)).toBeNull()
    expect(gum).not.toHaveBeenCalled()
    const setup = JSON.parse(ws.sent[0])
    expect(setup.token).toBe("tok-123"); expect(setup.assignment_id).toBe("A1"); expect(setup.course_id).toBe("C1")
    await act(async () => { await ws.msg({ setupComplete: {} }) })
    await waitFor(() => expect(screen.getByText(/Listening to you/)).toBeTruthy())
    expect(gum).toHaveBeenCalledTimes(1)
  })

  it("microphone denied: reports it AND closes the provider connection (no session left open)", async () => {
    gum.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }))
    const ws = await connect()
    await act(async () => { await ws.msg({ setupComplete: {} }) })
    await waitFor(() => expect(screen.getByText(/Microphone access denied/)).toBeTruthy())
    expect(ws.closeCalls).toBeGreaterThan(0)
    expect(screen.getByText("Disconnected")).toBeTruthy()
    expect(screen.getByText("Retry")).toBeTruthy()
  })

  it("no microphone present: says so", async () => {
    gum.mockRejectedValueOnce(Object.assign(new Error("none"), { name: "NotFoundError" }))
    const ws = await connect()
    await act(async () => { await ws.msg({ setupComplete: {} }) })
    await waitFor(() => expect(screen.getByText(/No microphone was found/)).toBeTruthy())
  })
})

describe("Live Voice: resources are always released", () => {
  it("closing the panel while the browser is still asking for the microphone does not leave the mic on", async () => {
    let grant!: (s: any) => void
    gum.mockImplementationOnce(() => new Promise((res) => { grant = res }))
    const ws = await connect()
    const { unmount } = { unmount: () => cleanup() }
    act(() => { void ws.msg({ setupComplete: {} }) })
    await flush()
    unmount()                                                    // user hangs up before answering the permission prompt
    const track = { stop: vi.fn() }
    await act(async () => { grant({ getTracks: () => [track] }) })
    expect(track.stop).toHaveBeenCalledTimes(1)                  // the late stream was stopped, not leaked
  })

  it("the server ending the session releases the microphone and audio, and says why", async () => {
    const ws = await connect()
    await act(async () => { await ws.msg({ setupComplete: {} }) })
    await waitFor(() => expect(tracks.length).toBe(1))
    act(() => ws.serverClose(1000, "idle_timeout"))
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(audioClosed).toBeGreaterThan(0)
    expect(screen.getByText("Session ended")).toBeTruthy()
    expect(screen.getByText(/period of silence/)).toBeTruthy()
  })

  it("unmounting stops the microphone and closes the socket", async () => {
    const ws = await connect()
    await act(async () => { await ws.msg({ setupComplete: {} }) })
    await waitFor(() => expect(tracks.length).toBe(1))
    cleanup()
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(ws.closeCalls).toBeGreaterThan(0)
  })

  it("hanging up calls onClose and releases everything", async () => {
    const onClose = vi.fn()
    mount({ onClose })
    const ws = FakeWS.all[0]
    await act(async () => { await ws.open(); await ws.msg({ setupComplete: {} }) })
    await waitFor(() => expect(tracks.length).toBe(1))
    fireEvent.click(screen.getByTitle("End Live Voice Call"))
    expect(onClose).toHaveBeenCalled(); expect(tracks[0].stop).toHaveBeenCalled(); expect(ws.closeCalls).toBeGreaterThan(0)
  })
})

describe("Live Voice: failures and retry", () => {
  it("an authentication failure shows the server's reason and offers Retry", async () => {
    const ws = await connect()
    act(() => ws.serverClose(1008, "Authentication failed"))
    expect(screen.getByText("Authentication failed")).toBeTruthy()
    expect(screen.getByText("Disconnected")).toBeTruthy()
    expect(screen.getByText("Retry")).toBeTruthy()
  })

  it("a late close event from the OLD socket cannot put the NEW session into an error state", async () => {
    const ws1 = await connect()
    act(() => ws1.serverClose(1011, "provider failed"))
    expect(screen.getByText("Disconnected")).toBeTruthy()
    fireEvent.click(screen.getByText("Retry"))
    expect(FakeWS.all.length).toBe(2)
    expect(screen.getByText(/Connecting to Gemini/)).toBeTruthy()
    act(() => { ws1.onclose?.({ code: 1005, reason: "" }) })     // a stale event arriving after the retry started (handler is detached, so this is a no-op)
    expect(screen.getByText(/Connecting to Gemini/)).toBeTruthy()
    expect(screen.queryByText("Disconnected")).toBeNull()
  })

  it("a socket-level error is surfaced, not swallowed", async () => {
    mount()
    const ws = FakeWS.all[0]
    act(() => ws.onerror?.({}))
    expect(screen.getByText(/Connection to live voice service failed/)).toBeTruthy()
  })

  it("never starts capturing if the socket dies before the browser answers", async () => {
    mount()
    const ws = FakeWS.all[0]
    act(() => ws.serverClose(1008, "Forbidden origin"))
    expect(gum).not.toHaveBeenCalled()
    expect(ws.sent.length).toBe(0)
  })
})

describe("Live Voice: board tools go through the proper path", () => {
  it("a provider tool call is executed by the board and its result is sent back", async () => {
    const ws = await connect()
    await act(async () => { await ws.msg({ setupComplete: {} }) })
    await act(async () => { await ws.msg({ toolCall: { functionCalls: [{ id: "f1", name: "add_text", args: { text: "hi" }, element_id: "signed" }] } }) })
    expect(h.tools).toHaveBeenCalledTimes(1)
    const reply = ws.sent.map((s) => JSON.parse(s)).find((m) => m.toolResponse)
    expect(reply.toolResponse.functionResponses[0]).toEqual({ id: "f1", response: { ok: true } })
  })
})

describe("describeLiveClose", () => {
  it.each([
    [1000, "idle_timeout", true, /silence/], [1000, "max_duration", true, /15-minute/], [1000, "provider_closed", true, /ended/],
    [1009, "message_too_large", false, /too large/], [1011, "provider_error", false, /interrupted/],
    [1008, "Concurrent live session limit exceeded", false, /limit exceeded/], [1000, "", true, /^$/], [1006, "", false, /disconnected/i],
  ])("%s %s", (code, reason, ok, msg) => {
    const r = describeLiveClose(code as number, reason as string)
    expect(r.ok).toBe(ok); expect(r.message).toMatch(msg as RegExp)
  })
})

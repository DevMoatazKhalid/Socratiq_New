// Polyfill WebSocket in Node test environment so Supabase client doesn't throw
if (typeof globalThis.WebSocket === "undefined") {
  class MockWebSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = 1
    onopen: any = null
    onclose: any = null
    onerror: any = null
    onmessage: any = null
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true }
  }
  // @ts-ignore
  globalThis.WebSocket = MockWebSocket as any
}

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"

const mockChannel = {
  on: vi.fn((_type: string, _opts: any, cb: any) => {
    mockChannel._cb = cb
    return mockChannel
  }),
  subscribe: vi.fn((cb?: (status: string) => void) => {
    if (cb) cb("SUBSCRIBED")
    return mockChannel
  }),
  _cb: null as any,
}

vi.mock("./supabase", () => ({
  isConfigured: true,
  supabase: {
    channel: vi.fn(() => mockChannel),
    removeChannel: vi.fn(async () => "ok"),
  },
}))

import { useRealtimeSubscription, useWhiteboardRealtimeSync } from "./realtime"
import { supabase } from "./supabase"

describe("useRealtimeSubscription", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    mockChannel._cb = null
    vi.clearAllMocks()
  })

  it("subscribes to channel and invalidates query keys on event", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children)

    renderHook(
      () =>
        useRealtimeSubscription({
          table: "attempts",
          filter: "assignment_id=eq.test-123",
          invalidateKeys: [["student", "whiteboard", "test-123"]],
        }),
      { wrapper }
    )

    expect(supabase.channel).toHaveBeenCalled()
    expect(mockChannel.on).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({
        table: "attempts",
        filter: "assignment_id=eq.test-123",
      }),
      expect.any(Function)
    )

    // Trigger callback
    if (mockChannel._cb) {
      mockChannel._cb({ new: { id: "attempt-1" } })
    }
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["student", "whiteboard", "test-123"],
    })
  })

  it("triggers query invalidation on initial connection and reconnection", () => {
    let statusCallback: ((status: string) => void) | null = null
    mockChannel.subscribe.mockImplementationOnce((cb?: (status: string) => void) => {
      statusCallback = cb || null
      return mockChannel
    })

    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children)

    renderHook(
      () =>
        useRealtimeSubscription({
          table: "attempts",
          filter: "assignment_id=eq.test-456",
          invalidateKeys: [["student", "whiteboard", "test-456"]],
        }),
      { wrapper }
    )

    // Simulate reconnection after dropped connection
    if (statusCallback) {
      ;(statusCallback as any)("SUBSCRIBED")
    }
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["student", "whiteboard", "test-456"],
    })
  })

  it("cleans up channel on unmount", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children)

    const { unmount } = renderHook(
      () =>
        useWhiteboardRealtimeSync("test-asg-1"),
      { wrapper }
    )

    unmount()
    expect(supabase.removeChannel).toHaveBeenCalledWith(mockChannel)
  })

  it("does NOT tear down and recreate the channel on every re-render (inline invalidateKeys / onPayload)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children)
    const { rerender, unmount } = renderHook(
      () => useWhiteboardRealtimeSync("A1"),                       // builds a brand-new invalidateKeys array on every render
      { wrapper }
    )
    rerender(); rerender(); rerender()
    expect(supabase.channel).toHaveBeenCalledTimes(1)
    expect(supabase.removeChannel).not.toHaveBeenCalled()
    unmount()
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)        // cleaned up exactly once on unmount
  })

  it("resubscribes when the subscription's identity (filter) really changes, and uses the latest callbacks", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children)
    const first = vi.fn(), second = vi.fn()
    const { rerender } = renderHook(
      ({ f, cb }: { f: string; cb: (p: unknown) => void }) => useRealtimeSubscription({ table: "attempts", filter: f, onPayload: cb }),
      { wrapper, initialProps: { f: "assignment_id=eq.A1", cb: first } }
    )
    rerender({ f: "assignment_id=eq.A1", cb: second })              // only the callback changed: same channel, newest callback wins
    expect(supabase.channel).toHaveBeenCalledTimes(1)
    mockChannel._cb({ x: 1 })
    expect(second).toHaveBeenCalledWith({ x: 1 }); expect(first).not.toHaveBeenCalled()
    rerender({ f: "assignment_id=eq.A2", cb: second })              // a different assignment: a different channel
    expect(supabase.channel).toHaveBeenCalledTimes(2)
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
  })

  it("works (as a no-op invalidator) without a QueryClientProvider", () => {
    const onPayload = vi.fn()
    expect(() => renderHook(() => useRealtimeSubscription({ table: "attempts", onPayload }))).not.toThrow()
    mockChannel._cb({ y: 2 })
    expect(onPayload).toHaveBeenCalledWith({ y: 2 })
  })
})

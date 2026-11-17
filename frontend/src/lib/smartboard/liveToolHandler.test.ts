// @vitest-environment jsdom
import "@/test/excalidrawEnv"
import { describe, expect, it, vi } from "vitest"
import { executeLiveTools, type ToolCall } from "./liveToolHandler"

describe("executeLiveTools", () => {
  const mockApi: any = {
    getSceneElementsIncludingDeleted: () => [],
    getAppState: () => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: 800, height: 600 }),
    updateScene: vi.fn(),
    addFiles: vi.fn(),
    scrollToContent: vi.fn(),
  }

  it("handles draw_rectangle tool call", async () => {
    const calls: ToolCall[] = [
      {
        id: "call-1",
        name: "draw_rectangle",
        args: { x: 50, y: 50, width: 120, height: 80, color: "#2563eb", filled: true },
        element_id: "el-rect-1",
      },
    ]

    const responses = await executeLiveTools(calls, mockApi, {})
    expect(responses.length).toBe(1)
    expect(responses[0].id).toBe("call-1")
    expect(responses[0].response.output.shape).toBe("rectangle")
    expect(mockApi.updateScene).toHaveBeenCalled()
  })

  it("handles write_text tool call", async () => {
    const calls: ToolCall[] = [
      {
        id: "call-2",
        name: "write_text",
        args: { text: "Hello SocratiQ", x: 100, y: 150 },
        element_id: "el-text-1",
      },
    ]

    const responses = await executeLiveTools(calls, mockApi, {})
    expect(responses.length).toBe(1)
    expect(responses[0].id).toBe("call-2")
    expect(responses[0].response.output.text).toBe("Hello SocratiQ")
  })

  it("handles pan_view tool call without creating elements", async () => {
    const calls: ToolCall[] = [
      {
        id: "call-3",
        name: "pan_view",
        args: { x: 500, y: 300 },
      },
    ]

    const responses = await executeLiveTools(calls, mockApi, {})
    expect(responses.length).toBe(1)
    expect(responses[0].response.output.pannedTo).toEqual({ x: 500, y: 300 })
  })
})

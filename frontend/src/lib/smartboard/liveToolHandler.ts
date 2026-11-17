import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import type { BinaryFileData } from "@excalidraw/excalidraw/types"
import { CaptureUpdateAction } from "@excalidraw/excalidraw"
import type { BoardElement } from "@/lib/whiteboard"
import { planCoachInsertion } from "./coachInsert"
import { viewportRect } from "./placement"
import { boardDigest } from "./glue"
import { retrieveCourseMaterials, generateVectorDrawing, generateImageContent, generateSimulationCode } from "@/lib/geminiSmartBoardService"
import type { SceneEl } from "./types"

export interface ToolCall {
  name: string
  id: string
  args: Record<string, any>
  element_id?: string
  functionCall?: {
    name?: string
    element_id?: string
  }
}

export interface ToolResponse {
  id: string
  response: {
    result?: any
    output?: any
    error?: string
  }
}

export async function executeLiveTools(
  calls: ToolCall[],
  api: ExcalidrawImperativeAPI,
  context: { assignmentId?: string; courseId?: string }
): Promise<ToolResponse[]> {
  const responses: ToolResponse[] = []
  const coachElementsToAdd: BoardElement[] = []
  const opId = `live-${Date.now()}`
  // The same brain gates what Live asks the board to create: the assignment's policy applies, and a Coach redirect is handed back to the model as the tool's error.
  const genCtx = { assignmentId: context.assignmentId, throwOnRedirect: true }

  for (const call of calls) {
    const name = call.name || call.functionCall?.name || ""
    const args = call.args || {}
    const elementId = call.element_id || call.functionCall?.element_id || `coach-live-${crypto.randomUUID()}`
    let toolResult: any = { status: "success" }

    try {
      if (name === "draw_rectangle") {
        coachElementsToAdd.push({
          id: elementId,
          kind: "shape",
          shape: "rect",
          author: "coach",
          seq: 0,
          x: args.x ?? 100,
          y: args.y ?? 100,
          w: Math.max(10, args.width ?? 120),
          h: Math.max(10, args.height ?? 80),
          color: args.color || "#0f766e",
          filled: Boolean(args.filled),
        })
        toolResult = { created: elementId, shape: "rectangle" }
      } else if (name === "draw_circle") {
        const r = Math.max(8, args.radius ?? 40)
        coachElementsToAdd.push({
          id: elementId,
          kind: "circle",
          shape: "circle",
          author: "coach",
          seq: 0,
          x: (args.x ?? 100) - r,
          y: (args.y ?? 100) - r,
          w: r * 2,
          h: r * 2,
          color: args.color || "#0f766e",
          filled: Boolean(args.filled),
        })
        toolResult = { created: elementId, shape: "circle" }
      } else if (name === "draw_triangle") {
        coachElementsToAdd.push({
          id: elementId,
          kind: "triangle",
          shape: "triangle",
          author: "coach",
          seq: 0,
          x: args.x ?? 100,
          y: args.y ?? 100,
          w: Math.max(10, args.width ?? 100),
          h: Math.max(10, args.height ?? 90),
          color: args.color || "#0f766e",
          filled: Boolean(args.filled),
        })
        toolResult = { created: elementId, shape: "triangle" }
      } else if (name === "draw_line") {
        coachElementsToAdd.push({
          id: elementId,
          kind: "line",
          author: "coach",
          seq: 0,
          x: args.x1 ?? 100,
          y: args.y1 ?? 100,
          w: (args.x2 ?? 200) - (args.x1 ?? 100),
          h: (args.y2 ?? 200) - (args.y1 ?? 100),
          x2: args.x2 ?? 200,
          y2: args.y2 ?? 200,
          color: args.color || "#0f766e",
          strokeWidth: args.strokeWidth ?? 3,
        })
        toolResult = { created: elementId, shape: "line" }
      } else if (name === "draw_arrow") {
        coachElementsToAdd.push({
          id: elementId,
          kind: "arrow",
          author: "coach",
          seq: 0,
          x: args.x1 ?? 100,
          y: args.y1 ?? 100,
          w: (args.x2 ?? 200) - (args.x1 ?? 100),
          h: (args.y2 ?? 200) - (args.y1 ?? 100),
          x2: args.x2 ?? 200,
          y2: args.y2 ?? 200,
          color: args.color || "#0f766e",
          strokeWidth: args.strokeWidth ?? 3,
        })
        toolResult = { created: elementId, shape: "arrow" }
      } else if (name === "write_text") {
        coachElementsToAdd.push({
          id: elementId,
          kind: "text",
          author: "coach",
          seq: 0,
          x: args.x ?? 100,
          y: args.y ?? 100,
          w: Math.max(60, (args.text || "").length * 10),
          h: 40,
          text: args.text || "",
          color: args.color || "#0f172a",
          fontSize: args.fontSize ?? 20,
        })
        toolResult = { created: elementId, text: args.text }
      } else if (name === "add_equation") {
        coachElementsToAdd.push({
          id: elementId,
          kind: "equation",
          author: "coach",
          seq: 0,
          x: args.x ?? 100,
          y: args.y ?? 100,
          w: Math.max(60, (args.latex || "").length * 12),
          h: 45,
          latex: args.latex || "",
          color: args.color || "#0f172a",
        })
        toolResult = { created: elementId, equation: args.latex }
      } else if (name === "pan_view") {
        const targetX = args.x ?? 0
        const targetY = args.y ?? 0
        api.updateScene({
          appState: {
            scrollX: -targetX,
            scrollY: -targetY,
          } as any,
        })
        toolResult = { pannedTo: { x: targetX, y: targetY } }
      } else if (name === "clear_board") {
        // Soft clear: delete only coach elements or mark elements as deleted
        const elements = api.getSceneElementsIncludingDeleted()
        const cleared = elements.map((e) => {
          const meta = (e.customData as any)?.socratiq
          if (meta?.author === "coach" || meta?.author === "ai") {
            return { ...e, isDeleted: true }
          }
          return e
        })
        api.updateScene({ elements: cleared as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
        toolResult = { cleared: "coach elements removed" }
      } else if (name === "search_course_materials") {
        const query = args.query || ""
        const chunks = await retrieveCourseMaterials(query, context.assignmentId, context.courseId, args.top_k || 3)
        toolResult = {
          results: chunks.map((r: any) => ({
            title: r.document_title || r.source,
            page: r.page_number,
            content: (r.content || "").slice(0, 500),
          })),
        }
      } else if (name === "get_board_context") {
        const els = api.getSceneElementsIncludingDeleted() as readonly SceneEl[]
        const digest = boardDigest(els)
        toolResult = {
          elementCount: els.filter((e) => !e.isDeleted).length,
          boardTextDigest: digest,
        }
      } else if (name === "generate_vector_drawing") {
        const shapes = await generateVectorDrawing(args.prompt, genCtx)
        if (shapes && Array.isArray(shapes) && shapes.length > 0) {
          shapes.forEach((s: any, idx: number) => {
            const sid = `${elementId}-${idx}`
            coachElementsToAdd.push({
              id: sid,
              kind: s.type === "circle" ? "circle" : s.type === "triangle" ? "triangle" : s.type === "line" ? "line" : "shape",
              shape: s.type === "circle" ? "circle" : s.type === "triangle" ? "triangle" : "rect",
              author: "coach",
              seq: 0,
              x: (args.x ?? 100) + (s.x || 0),
              y: (args.y ?? 100) + (s.y || 0),
              w: s.width || (s.radius ? s.radius * 2 : 80),
              h: s.height || (s.radius ? s.radius * 2 : 80),
              color: s.color || "#0f766e",
              filled: Boolean(s.filled),
            })
          })
          toolResult = { vectorCount: shapes.length }
        } else {
          toolResult = { status: "no shapes generated" }
        }
      } else if (name === "generate_image") {
        const promptText = (typeof args?.prompt === "string" && args.prompt.trim())
          ? args.prompt.trim()
          : (typeof args?.description === "string" && args.description.trim())
          ? args.description.trim()
          : (typeof args?.text === "string" && args.text.trim())
          ? args.text.trim()
          : "educational illustration"
        const imgSize = (args?.size === "2K" || args?.size === "4K") ? args.size : "1K"
        const src = await generateImageContent(promptText, imgSize, genCtx)
        if (src) {
          coachElementsToAdd.push({
            id: elementId,
            kind: "image",
            author: "coach",
            seq: 0,
            x: args.x ?? 100,
            y: args.y ?? 100,
            w: 300,
            h: 300,
            src,
          })
          toolResult = { status: "image generated", imageId: elementId }
        } else {
          toolResult = { error: "Image generation failed" }
        }
      } else if (name === "generate_simulation") {
        const code = await generateSimulationCode(args.prompt, genCtx)
        if (code) {
          // The board inserts the simulation as a managed, live board element (SmartBoardWorkspace.insertSimulationCard). It used to ALSO push a legacy
          // element here, which the native board rendered as a dashed placeholder next to the real card.
          window.dispatchEvent(new CustomEvent("socratiq-open-simulation", { detail: { id: elementId, title: args.title || args.prompt, code } }))
          toolResult = { status: "simulation created", id: elementId }
        } else {
          toolResult = { error: "Simulation generation failed" }
        }
      } else {
        toolResult = { status: "acknowledged", name }
      }
    } catch (err: any) {
      toolResult = { error: err?.message || String(err) }
    }

    responses.push({
      id: call.id,
      response: { result: toolResult, output: toolResult },
    })
  }

  // Insert all planned coach elements onto the native Excalidraw board at once using collision-free placement
  if (coachElementsToAdd.length > 0) {
    try {
      const existing = api.getSceneElementsIncludingDeleted()
      const vp = viewportRect(api.getAppState())
      const plan = planCoachInsertion({
        existing,
        coach: coachElementsToAdd,
        viewport: vp,
        opId,
      })

      if (plan.ok) {
        const files = Object.values(plan.files) as BinaryFileData[]
        if (files.length) {
          api.addFiles(files)
        }
        api.updateScene({
          elements: plan.all,
          appState: {
            selectedElementIds: {},
            selectedGroupIds: { [plan.groupId]: true },
          } as never,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        })
        api.scrollToContent(plan.added, {
          fitToViewport: true,
          viewportZoomFactor: 0.85,
          animate: true,
          duration: 350,
        })
      } else {
        console.warn("[liveToolHandler] planCoachInsertion failed:", plan.reason, plan.diagnostics)
      }
    } catch (e) {
      console.error("[liveToolHandler] Failed to apply coach elements to scene:", e)
    }
  }

  return responses
}

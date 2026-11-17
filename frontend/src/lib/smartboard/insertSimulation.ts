import { convertToExcalidrawElements } from "@excalidraw/excalidraw"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { withMeta } from "./meta"
import { ObstacleIndex } from "./obstacles"
import { findPlacement } from "./placement"
import { assignIndices, validateInsertion } from "./insertAi"
import type { Rect, SceneEl } from "./types"

import type { SimulationRecord } from "./simulationRef"

export type SimulationCardData = SimulationRecord

/** Card size in scene units. The generation prompt designs for 320x240 up to 900x700; the layer reserves HEADER_H of this for its title bar. */
export const SIM_CARD_W = 520
export const SIM_CARD_H = 420

export interface PlanSimulationArgs {
  simulation: SimulationCardData
  elements: readonly ExcalidrawElement[]
  viewport?: Rect | null
  opId: string
  width?: number
  height?: number
  now?: number
}

export type PlanSimulationResult =
  | {
      ok: true
      all: ExcalidrawElement[]
      added: ExcalidrawElement[]
      groupId: string
      opId: string
      rect: Rect
      visible: boolean
      simulation: SimulationCardData
    }
  | { ok: false; reason: string; message: string }

export function planSimulationInsertion(args: PlanSimulationArgs): PlanSimulationResult {
  const now = args.now ?? Date.now()
  const w = args.width ?? SIM_CARD_W
  const h = args.height ?? SIM_CARD_H

  const live = args.elements.filter((e) => !e.isDeleted) as SceneEl[]
  const index = new ObstacleIndex(live)

  const p = findPlacement(index, {
    size: { w, h },
    viewport: args.viewport,
    anchor: null,
  })

  if (!p.ok) {
    return {
      ok: false,
      reason: p.reason,
      message: "Could not find a clear space on your board for this simulation.",
    }
  }

  const id = `sim-card-${crypto.randomUUID()}`
  const groupId = `group-sim-${crypto.randomUUID()}`

  const cardSkeleton: any = {
    type: "rectangle",
    id,
    x: p.x,
    y: p.y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "#0f766e",
    backgroundColor: "#ffffff",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [groupId],
    roundness: { type: 3 },
    customData: {
      ...withMeta(undefined, {
        // AI-generated content the student asked for and pinned: "ai", like the diagrams and images. "coach" would be wrong (this is not the Coach's
        // pedagogical writing) and the server demotes any unsigned "coach" claim to "student", which would erase the provenance on save.
        author: "ai",
        opId: args.opId,
        role: "simulation",
        legacyId: `sim-${args.simulation.id}`,
      }),
      // Only a pointer: the code is stored in the scene's `simulations` map (see simulationRef.ts), clear of customData's 4 KB cap.
      simulationRef: { id: args.simulation.id, title: args.simulation.title },
    },
  }

  const converted = convertToExcalidrawElements([cardSkeleton], { regenerateIds: false }) as ExcalidrawElement[]

  const problems = validateInsertion(index, converted, 0)
  if (problems.length > 0) {
    console.warn("[insertSimulation] Warning during simulation insertion validation:", problems)
  }

  const added = assignIndices(args.elements, converted)
  const rect: Rect = { x: p.x, y: p.y, w, h }
  const visible = args.viewport
    ? p.x >= args.viewport.x &&
      p.y >= args.viewport.y &&
      p.x + w <= args.viewport.x + args.viewport.w &&
      p.y + h <= args.viewport.y + args.viewport.h
    : true

  return {
    ok: true,
    all: [...args.elements, ...added],
    added,
    groupId,
    opId: args.opId,
    rect,
    visible,
    simulation: args.simulation,
  }
}

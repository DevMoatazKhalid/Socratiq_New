/**
 * How a simulation card on the native board points at its source code.
 *
 * The card is an ordinary Excalidraw rectangle (a type the server accepts) whose customData carries only `simulationRef: {id,title}`.
 * The code itself lives in the scene's `simulations` map, next to image `files`, because customData is capped at 4 KB and real simulations
 * are larger (see ai/whiteboard/scene.py). Boards saved by earlier clients keep a small inline `customData.simulation`; both forms resolve here.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"

export interface SimulationRecord { id: string; title: string; code: string }
export type SimulationMap = Record<string, SimulationRecord>

export const SIMULATION_ROLE = "simulation"

const cd = (el: { customData?: unknown }) => (el.customData && typeof el.customData === "object" ? (el.customData as Record<string, any>) : {})

export const isSimulationCard = (el: ExcalidrawElement) => !el.isDeleted && cd(el).socratiq?.role === SIMULATION_ROLE && (!!cd(el).simulationRef?.id || !!cd(el).simulation?.code)

export function simulationRefId(el: ExcalidrawElement): string | null {
  const id = cd(el).simulationRef?.id ?? cd(el).simulation?.id
  return typeof id === "string" && id ? id : null
}

/** The record for a card: from the map, else the legacy inline copy. Null when the code is missing (the card then shows a clear message). */
export function resolveSimulation(el: ExcalidrawElement, records: SimulationMap): SimulationRecord | null {
  const id = simulationRefId(el)
  if (id && records[id]) return records[id]
  const inline = cd(el).simulation
  if (inline && typeof inline.code === "string" && typeof inline.id === "string") return { id: inline.id, title: String(inline.title ?? ""), code: inline.code }
  return null
}

/** Only records a LIVE element still points at are persisted (deleted cards are not saved; an undo in the same session re-saves them from memory). */
export function referencedSimulations(elements: readonly ExcalidrawElement[], records: SimulationMap): SimulationMap {
  const out: SimulationMap = {}
  for (const el of elements) { if (el.isDeleted) continue; const id = cd(el).simulationRef?.id; if (typeof id === "string" && records[id]) out[id] = records[id] }
  return out
}

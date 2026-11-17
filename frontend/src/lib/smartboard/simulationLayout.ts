/** Geometry of simulation cards on the board: scene coordinates -> positions inside the board container. Pure, so it is unit-tested. */
export interface BoardViewport { scrollX: number; scrollY: number; zoom: number; width: number; height: number }
export interface SceneBox { x: number; y: number; width: number; height: number; angle?: number }
export interface ScreenBox { left: number; top: number; width: number; height: number }

/** Height reserved at the top of a card for the title bar, in scene units (scales with zoom together with the card). */
export const SIM_HEADER_H = 38
/** Excalidraw's own mapping: screen = (scene + scroll) * zoom. Relative to the board container, so no page offset is added. */
export function toScreenBox(b: SceneBox, v: BoardViewport): ScreenBox {
  return { left: (b.x + v.scrollX) * v.zoom, top: (b.y + v.scrollY) * v.zoom, width: b.width * v.zoom, height: b.height * v.zoom }
}
export function isOffscreen(s: ScreenBox, v: BoardViewport, margin = 0): boolean {
  return s.left + s.width < -margin || s.top + s.height < -margin || s.left > v.width + margin || s.top > v.height + margin
}
export const sameViewport = (a: BoardViewport, b: BoardViewport) =>
  a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom && a.width === b.width && a.height === b.height

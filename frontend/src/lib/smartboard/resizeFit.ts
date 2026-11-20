/**
 * Keeps board content reachable when the board's container changes size (window resize, split ratio, panel collapse/expand, fullscreen).
 *
 * WHY THIS EXISTS: Excalidraw re-measures its canvas when its container resizes but deliberately keeps scrollX / scrollY / zoom. The scroll is the
 * scene coordinate at the canvas's top-left, so a narrower canvas simply shows LESS of the scene and anything that was near the right/bottom edge
 * slides out of view. Nothing was deleted, but it looked like it was, and nothing ever brought it back. This module decides, from numbers only,
 * when to re-fit (shrink) and when to give the previous view back (grow). The scene coordinate system and the persisted elements are never touched:
 * only the viewport (scroll/zoom, which is not part of the saved element data) changes.
 */

export interface Bounds { x1: number; y1: number; x2: number; y2: number }
/** Excalidraw's appState view: scroll is in scene units, zoom is screen px per scene unit, width/height are the canvas size in screen px. */
export interface ViewState { scrollX: number; scrollY: number; zoom: number; width: number; height: number }
export interface ViewPose { scrollX: number; scrollY: number; zoom: number }
/** Remembers the view the student had before an automatic fit, so growing the panel again can restore it instead of leaving a tiny zoom behind. */
export interface FitMemo { before: ViewPose; fit: ViewPose }
export type ResizeDecision =
  | { kind: "none"; memo: FitMemo | null }
  | { kind: "fit"; before: ViewPose; keep: FitMemo | null }
  | { kind: "restore"; view: ViewPose; memo: null }

const EPS_ZOOM = 0.001
const EPS_SCROLL = 1.5

export const usable = (v: { width: number; height: number }) => Number.isFinite(v.width) && Number.isFinite(v.height) && v.width > 1 && v.height > 1

/** Bounding box of the live (non-deleted) elements, or null for an empty board. Uses x/y/width/height, which is exact for every non-rotated element. */
export function contentBounds(els: readonly { x: number; y: number; width: number; height: number; isDeleted?: boolean }[]): Bounds | null {
  let b: Bounds | null = null
  for (const e of els) {
    if (e.isDeleted) continue
    const x1 = Math.min(e.x, e.x + e.width), x2 = Math.max(e.x, e.x + e.width)
    const y1 = Math.min(e.y, e.y + e.height), y2 = Math.max(e.y, e.y + e.height)
    b = b ? { x1: Math.min(b.x1, x1), y1: Math.min(b.y1, y1), x2: Math.max(b.x2, x2), y2: Math.max(b.y2, y2) } : { x1, y1, x2, y2 }
  }
  return b
}

/** Scene-space rectangle the canvas currently shows. */
export function visibleRect(v: ViewState): Bounds {
  return { x1: -v.scrollX, y1: -v.scrollY, x2: -v.scrollX + v.width / v.zoom, y2: -v.scrollY + v.height / v.zoom }
}

export function isFullyVisible(b: Bounds, v: ViewState): boolean {
  const r = visibleRect(v)
  return b.x1 >= r.x1 - 0.5 && b.y1 >= r.y1 - 0.5 && b.x2 <= r.x2 + 0.5 && b.y2 <= r.y2 + 0.5
}

const samePose = (a: ViewPose, b: ViewPose) => Math.abs(a.zoom - b.zoom) < EPS_ZOOM && Math.abs(a.scrollX - b.scrollX) < EPS_SCROLL && Math.abs(a.scrollY - b.scrollY) < EPS_SCROLL

/**
 * `prev` is the view at the LAST usable size (same scroll/zoom, old canvas size); `next` is the same scroll/zoom at the new canvas size.
 *
 *  - Shrink: if everything WAS in view and is no longer, fit the content (the caller zooms out, never below the board's minimum zoom, and may pan).
 *  - Grow: if we auto-fitted earlier and the student has not zoomed or panned since, give back the earlier view when it fits the larger canvas,
 *    otherwise re-fit to the bigger space so the zoom is useful again.
 *  - Deliberate views are respected: when the student was already zoomed in on part of the board (content was not fully in view before the resize),
 *    or has moved the view since our fit, nothing is moved.
 *  - Empty board, hidden/zero-size container: nothing to do.
 */
export function decideResizeView(bounds: Bounds | null, prev: ViewState, next: ViewState, memo: FitMemo | null): ResizeDecision {
  if (!bounds || !usable(next)) return { kind: "none", memo }
  const now: ViewPose = { scrollX: next.scrollX, scrollY: next.scrollY, zoom: next.zoom }
  const memoValid = !!memo && samePose(now, memo.fit)
  if (memoValid) {
    const grew = next.width * next.height > prev.width * prev.height
    if (grew) {
      if (isFullyVisible(bounds, { ...memo!.before, width: next.width, height: next.height })) return { kind: "restore", view: memo!.before, memo: null }
      return { kind: "fit", before: memo!.before, keep: memo }     // bigger canvas but the old view still would not show everything: use the space
    }
    if (!isFullyVisible(bounds, next)) return { kind: "fit", before: memo!.before, keep: memo }
    return { kind: "none", memo }
  }
  const wasVisible = usable(prev) && isFullyVisible(bounds, prev)
  if (wasVisible && !isFullyVisible(bounds, next)) return { kind: "fit", before: { scrollX: prev.scrollX, scrollY: prev.scrollY, zoom: prev.zoom }, keep: null }
  return { kind: "none", memo: null }                              // deliberate view, or nothing was lost
}

export const makeMemo = (before: ViewPose, after: ViewPose): FitMemo => ({ before, fit: { scrollX: after.scrollX, scrollY: after.scrollY, zoom: after.zoom } })

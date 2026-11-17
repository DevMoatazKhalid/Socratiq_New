import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { BinaryFileData } from "@excalidraw/excalidraw/types"
import { withMeta } from "./meta"
import { ObstacleIndex } from "./obstacles"
import { findPlacement } from "./placement"
import { resolveAnchor } from "./anchor"
import { assignIndices, validateInsertion } from "./insertAi"
import type { Rect, SceneEl } from "./types"

export interface PlanImageArgs {
  imageDataUrl: string
  prompt: string
  elements: readonly ExcalidrawElement[]
  viewport?: Rect | null
  selectedIds?: readonly string[]
  opId: string
  width?: number
  height?: number
  now?: number
}

export type PlanImageResult =
  | {
      ok: true
      all: ExcalidrawElement[]
      added: ExcalidrawElement[]
      file: BinaryFileData
      groupId: string
      opId: string
      rect: Rect
      visible: boolean
    }
  | { ok: false; reason: string; message: string }

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function planImageInsertion(args: PlanImageArgs): PlanImageResult {
  const now = args.now ?? Date.now()
  const w = args.width ?? 380
  const h = args.height ?? 380

  // ── MIME whitelist validation ──────────────────────────────────────────────
  const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"])
  const DATA_URL_RE = /^data:(image\/(png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/\n\r=]+)$/
  const match = DATA_URL_RE.exec(args.imageDataUrl)
  if (!match) {
    // Try extracting MIME for a friendlier error message
    const mimeMatch = /^data:([^;,]+)/.exec(args.imageDataUrl)
    const detectedMime = mimeMatch ? mimeMatch[1] : "unknown"
    return {
      ok: false,
      reason: "invalid_image_format",
      message: ALLOWED_IMAGE_MIMES.has(detectedMime)
        ? "Image data is malformed or contains invalid base64 characters."
        : `Image type "${detectedMime}" is not allowed. Accepted formats: PNG, JPEG, WebP, SVG.`,
    }
  }

  const mimeType = match[1] as any
  const base64Data = match[3]

  // ── Size validation (reject decoded payload > 2.5MB) ───────────────────────
  const MAX_DECODED_BYTES = 2_500_000
  const estimatedBytes = Math.ceil((base64Data.length * 3) / 4)
  if (estimatedBytes > MAX_DECODED_BYTES) {
    return {
      ok: false,
      reason: "image_too_large",
      message: `Image exceeds the 2.5 MB size limit (estimated ${(estimatedBytes / 1_000_000).toFixed(1)} MB). Please use a smaller image.`,
    }
  }

  // ── Collision-resistant IDs ─────────────────────────────────────────────────
  const fileId = `img-${crypto.randomUUID()}`

  const file: BinaryFileData = {
    id: fileId as any,
    dataURL: args.imageDataUrl as any,
    mimeType,
    created: now,
  }

  const live = args.elements.filter((e) => !e.isDeleted) as SceneEl[]
  const index = new ObstacleIndex(live)

  const anchorRes = resolveAnchor({
    request: args.prompt,
    elements: live,
    selectedIds: args.selectedIds,
  })

  const p = findPlacement(index, {
    size: { w, h },
    viewport: args.viewport,
    anchor: anchorRes.anchor,
  })

  if (!p.ok) {
    return {
      ok: false,
      reason: p.reason,
      message: "Could not find a clear space on your board for this image.",
    }
  }

  const id = `img-${crypto.randomUUID()}`
  const groupId = `group-img-${crypto.randomUUID()}`

  const imageElement: any = {
    type: "image",
    id,
    x: p.x,
    y: p.y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [groupId],
    frameId: null,
    roundness: null,
    seed: hash(id),
    version: 1,
    versionNonce: hash(id + "nonce"),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: withMeta(undefined, {
      author: "ai",
      opId: args.opId,
      role: "image",
    }),
  }

  const problems = validateInsertion(index, [imageElement], 0)
  if (problems.length > 0) {
    console.warn("[insertImage] Warning during insertion validation:", problems)
  }

  const added = assignIndices(args.elements, [imageElement])
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
    file,
    groupId,
    opId: args.opId,
    rect,
    visible,
  }
}

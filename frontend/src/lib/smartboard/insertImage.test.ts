// @vitest-environment jsdom
import "@/test/excalidrawEnv"
import { describe, expect, it } from "vitest"
import { fitImageSize, planImageInsertion, wrapCaption } from "./insertImage"
import type { SceneEl } from "./types"

const mockDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("planImageInsertion", () => {
  it("creates an image element and binary file for an empty board", () => {
    const res = planImageInsertion({
      imageDataUrl: mockDataUrl,
      prompt: "diagram of a cell",
      elements: [],
      opId: "test-op-1",
      width: 300,
      height: 200,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.added.length).toBe(1)
      expect(res.added[0].type).toBe("image")
      expect(res.file.dataURL).toBe(mockDataUrl)
      expect(res.file.mimeType).toBe("image/png")
      expect(res.rect.w).toBe(300)
      expect(res.rect.h).toBe(200)
      expect(res.groupId).toMatch(/^group-img-/)
      expect(res.file.id).toMatch(/^img-/)
    }
  })

  it("avoids collision with existing elements", () => {
    const existing: SceneEl[] = [
      {
        id: "box1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        isDeleted: false,
      } as any,
    ]

    const res = planImageInsertion({
      imageDataUrl: mockDataUrl,
      prompt: "another item",
      elements: existing as any,
      opId: "test-op-2",
      width: 200,
      height: 200,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.added.length).toBe(1)
      const img = res.added[0]
      const overlaps =
        img.x < 400 && img.x + img.width > 0 && img.y < 400 && img.y + img.height > 0
      expect(overlaps).toBe(false)
    }
  })

  it("rejects forbidden or unwhitelisted image MIME types", () => {
    const forbiddenGif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    const res = planImageInsertion({
      imageDataUrl: forbiddenGif,
      prompt: "animated icon",
      elements: [],
      opId: "test-op-3",
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("invalid_image_format")
      expect(res.message).toContain("Accepted formats: PNG, JPEG, WebP, SVG")
    }
  })

  it("rejects non-image MIME types such as text/html or application/javascript", () => {
    const htmlPayload = "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="
    const res = planImageInsertion({
      imageDataUrl: htmlPayload,
      prompt: "xss test",
      elements: [],
      opId: "test-op-4",
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("invalid_image_format")
    }
  })

  it("rejects images exceeding the 6 MB payload limit", () => {
    // ~7.5 MB once decoded
    const bigB64 = "A".repeat(10_000_000)
    const bigPayload = `data:image/png;base64,${bigB64}`

    const res = planImageInsertion({
      imageDataUrl: bigPayload,
      prompt: "giant image",
      elements: [],
      opId: "test-op-5",
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("image_too_large")
      expect(res.message).toContain("6 MB size limit")
    }
  })

  it("generates distinct UUIDs for successive image insertions", () => {
    const res1 = planImageInsertion({
      imageDataUrl: mockDataUrl,
      prompt: "image 1",
      elements: [],
      opId: "op-a",
    })
    const res2 = planImageInsertion({
      imageDataUrl: mockDataUrl,
      prompt: "image 2",
      elements: [],
      opId: "op-b",
    })

    expect(res1.ok).toBe(true)
    expect(res2.ok).toBe(true)
    if (res1.ok && res2.ok) {
      expect(res1.file.id).not.toBe(res2.file.id)
      expect(res1.added[0].id).not.toBe(res2.added[0].id)
    }
  })

  it("keeps the picture's own aspect ratio and writes a caption under it, in the same group", () => {
    const res = planImageInsertion({ imageDataUrl: mockDataUrl, prompt: "water cycle", elements: [], opId: "op-cap", naturalWidth: 1600, naturalHeight: 900, caption: "The water cycle — labelled diagram" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const [img, cap] = res.added
    expect(img.width).toBe(440)
    expect(img.height).toBe(Math.round(440 / (16 / 9)))
    expect(cap.type).toBe("text")
    expect(cap.groupIds).toEqual(img.groupIds)
    expect(cap.y).toBeGreaterThan(img.y + img.height)
    expect(res.rect.h).toBeGreaterThan(img.height)
  })
})

describe("fitImageSize / wrapCaption", () => {
  it("fits portrait, landscape and unknown sizes", () => {
    expect(fitImageSize(900, 1600, 400)).toEqual({ w: 225, h: 400 })
    expect(fitImageSize(1600, 900, 400)).toEqual({ w: 400, h: 225 })
    expect(fitImageSize(undefined, undefined, 380)).toEqual({ w: 380, h: 380 })
  })
  it("wraps long captions to at most three lines", () => {
    const lines = wrapCaption("word ".repeat(80), 300)
    expect(lines.length).toBe(3)
    expect(lines[2].endsWith("…")).toBe(true)
  })
})

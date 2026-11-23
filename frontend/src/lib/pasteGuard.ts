import { useCallback, useEffect, useRef, useState } from "react"
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react"

/**
 * Paste guard for the comprehension (verification) answer field ONLY.
 *
 * The three verification answers are meant to show the student's own reasoning, so pasting into that field is blocked and a short,
 * friendly notice is shown instead. Every other text entry in the app (Coach chat, notes, code editor, SmartBoard, assessment forms)
 * keeps normal paste; do not reuse this hook elsewhere without a product decision (a scope test enforces this).
 *
 * Covered paste paths:
 *  - Ctrl+V / Cmd+V (and Ctrl+Shift+V / Cmd+Shift+V "paste as plain text"), Shift+Insert   -> keydown
 *  - right-click / long-press -> Paste, Edit menu -> Paste, any keyboard shortcut that slipped past keydown  -> `paste` event
 *  - mobile keyboards' clipboard suggestions and other input methods that insert from the clipboard      -> `beforeinput` insertFromPaste*
 *  - dragging text in from another window or app                                                         -> `drop` / insertFromDrop
 * Typing, selection, copy/cut, undo/redo, deletion, keyboard navigation and dragging a selection WITHIN the field are untouched.
 */
export const NO_PASTE_MESSAGE = "Please write your answer in your own words instead of pasting text."

const PASTE_INPUT_TYPES = new Set(["insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop"])

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { code?: string }

/** Ctrl/Cmd+V (with or without Shift) or Shift+Insert. Ctrl+Alt+V is left alone: on many layouts that is AltGr+V, which types a character. */
export function isPasteShortcut(e: KeyLike): boolean {
  const v = e.key?.toLowerCase() === "v" || e.code === "KeyV"
  if (v && (e.ctrlKey || e.metaKey) && !e.altKey) return true
  return e.key === "Insert" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
}

function carriesText(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const types = Array.from(dt.types ?? [])
  return types.length === 0 || types.some((t) => t === "text" || t.startsWith("text/"))
}

export function usePasteGuard({ message = NO_PASTE_MESSAGE, hideAfterMs = 4000 }: { message?: string; hideAfterMs?: number } = {}) {
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const node = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const internalDrag = useRef(false)          // a drag that started inside the field is the student moving their own text

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setNotice(null)
  }, [])

  const flag = useCallback(() => {
    setNotice(message)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; setNotice(null) }, hideAfterMs)
  }, [message, hideAfterMs])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // React's onBeforeInput is a legacy polyfill without `inputType`, so the native listener is attached through the ref.
  const onNativeBeforeInput = useCallback((e: Event) => {
    const t = (e as InputEvent).inputType
    if (t === "insertFromDrop" && internalDrag.current) return
    if (t && PASTE_INPUT_TYPES.has(t)) {
      e.preventDefault()
      flag()
    }
  }, [flag])

  const ref = useCallback((el: HTMLTextAreaElement | HTMLInputElement | null) => {
    if (node.current) node.current.removeEventListener("beforeinput", onNativeBeforeInput)
    node.current = el
    if (el) el.addEventListener("beforeinput", onNativeBeforeInput)
  }, [onNativeBeforeInput])

  const guardProps = {
    ref,
    onPaste: (e: ClipboardEvent<HTMLElement>) => { e.preventDefault(); flag() },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (isPasteShortcut(e)) { e.preventDefault(); flag() } },
    onDragStart: () => { internalDrag.current = true },
    onDragEnd: () => { internalDrag.current = false },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (internalDrag.current) return
      if (carriesText(e.dataTransfer)) { e.preventDefault(); flag() }
    },
  }

  return { notice, dismiss, guardProps }
}

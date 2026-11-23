import { describe, expect, it } from "vitest"
import { isPasteShortcut, NO_PASTE_MESSAGE } from "./pasteGuard"

const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, code?: string) =>
  ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe("isPasteShortcut", () => {
  it.each([
    ["Ctrl+V", k("v", { ctrlKey: true })],
    ["Cmd+V", k("v", { metaKey: true })],
    ["Ctrl+Shift+V (paste as plain text)", k("V", { ctrlKey: true, shiftKey: true })],
    ["Cmd+Shift+V", k("V", { metaKey: true, shiftKey: true })],
    ["Ctrl+V on a non-Latin layout (code KeyV)", k("ر", { ctrlKey: true }, "KeyV")],
    ["Shift+Insert", k("Insert", { shiftKey: true })],
  ])("blocks %s", (_, e) => expect(isPasteShortcut(e)).toBe(true))

  it.each([
    ["typing v", k("v")],
    ["typing V", k("V", { shiftKey: true })],
    ["Ctrl+C", k("c", { ctrlKey: true })],
    ["Cmd+C", k("c", { metaKey: true })],
    ["Ctrl+X", k("x", { ctrlKey: true })],
    ["Ctrl+A", k("a", { ctrlKey: true })],
    ["Cmd+A", k("a", { metaKey: true })],
    ["Ctrl+Z", k("z", { ctrlKey: true })],
    ["Ctrl+Y", k("y", { ctrlKey: true })],
    ["Ctrl+Insert (copy)", k("Insert", { ctrlKey: true })],
    ["Shift+Delete (cut)", k("Delete", { shiftKey: true })],
    ["AltGr+V (Ctrl+Alt+V types a character on some layouts)", k("v", { ctrlKey: true, altKey: true })],
    ["Backspace", k("Backspace")],
    ["ArrowLeft", k("ArrowLeft")],
    ["Shift+ArrowRight", k("ArrowRight", { shiftKey: true })],
    ["Home", k("Home")],
    ["Tab", k("Tab")],
  ])("allows %s", (_, e) => expect(isPasteShortcut(e)).toBe(false))
})

it("uses the agreed student-facing message", () => {
  expect(NO_PASTE_MESSAGE).toBe("Please write your answer in your own words instead of pasting text.")
})

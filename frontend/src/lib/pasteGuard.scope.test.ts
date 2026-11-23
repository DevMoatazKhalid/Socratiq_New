import { describe, expect, it } from "vitest"

/**
 * The paste block is a deliberate exception for the three comprehension (verification) answers. Chat, notes, the code editor, the
 * SmartBoard, assessment and every other input must keep normal paste. This test fails if the guard is wired anywhere else.
 */
const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../test/**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>

describe("paste guard scope", () => {
  it("is used only by the verification answer field", () => {
    const users = Object.entries(sources)
      .filter(([path, src]) => !path.endsWith("pasteGuard.ts") && /\busePasteGuard\b|from "@\/lib\/pasteGuard"/.test(src))
      .map(([path]) => path)
    expect(users).toEqual(["../pages/student/Verification.tsx"])
  })

  it("the scan actually sees the app's text inputs", () => {
    const paths = Object.keys(sources)
    expect(paths.length).toBeGreaterThan(50)
    for (const p of ["../pages/student/AiCoach.tsx", "../components/notes/NotesDrawer.tsx", "../components/socratiq/CodeEditor.tsx"])
      expect(paths).toContain(p)
  })
})

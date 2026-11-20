import { describe, expect, it } from "vitest"

/** Cross-checks the persona IDs and English display names the frontend is tested against with the canonical Python definitions
 *  (`ai/brain/personas.py`). It guards against the two drifting apart. Skipped when the repo root is not present (frontend-only checkout). */
const found = import.meta.glob("../../../ai/brain/personas.py", { query: "?raw", import: "default", eager: true }) as Record<string, string>
const src = Object.values(found)[0] ?? ""
const IDS = ["socratic_guide", "patient_mentor", "practical_engineer", "critical_thinker", "visual_explorer"]
const NAMES = ["The Socratic Guide", "The Patient Mentor", "The Practical Engineer", "The Critical Thinker", "The Visual Explorer"]

describe.skipIf(!src)("canonical persona definitions", () => {
  it("define exactly the five persona ids the UI is tested against, in order", () => {
    expect([...src.matchAll(/id="([a-z_]+)", version=\d+/g)].map((m) => m[1])).toEqual(IDS)
  })
  it("provide the English display names the UI renders", () => {
    expect([...src.matchAll(/name=LocalizedText\("([^"]+)"/g)].map((m) => m[1])).toEqual(NAMES)
  })
  it("keep socratic_guide as the default persona", () => {
    expect(src).toMatch(/DEFAULT_PERSONA_ID = "socratic_guide"/)
  })
})

import { describe, expect, it } from "vitest"
import { speakable } from "./voice"

describe("speakable", () => {
  it("removes markdown symbols but keeps the words", () => {
    expect(speakable("**Why** did you subtract `5`?\n\n> think")).toBe("Why did you subtract 5? think")
  })
  it("does not read code blocks aloud", () => {
    expect(speakable("Look:\n```py\nx = 1\n```\nWhat changes?")).toBe("Look: (code omitted) What changes?")
  })
})

describe("speakable with mathematics", () => {
  it("reads formulas as words instead of LaTeX", () => {
    const s = speakable("The area is $\\pi r^2$ and $$\\frac{a}{b}$$")
    expect(s).toContain("pi r squared")
    expect(s).toContain("a over b")
    expect(s).not.toMatch(/[$\\{}]/)
  })
  it("leaves prices alone", () => {
    expect(speakable("It costs $5 and $10.")).toBe("It costs $5 and $10.")
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { VisualResult } from "@/lib/queries"
import { VisualNoMatchCard, VisualResultCard, visibleSteps, visualCaption } from "./VisualResult"

afterEach(cleanup)

const base: VisualResult = {
  status: "ok", imageUrl: "data:image/png;base64,AAAA", width: 1280, height: 960, source: "retrieved", aiGenerated: false, kind: "photo",
  title: "Red fox", provider: "commons", attribution: { text: "Wikimedia Commons, Jane Doe, CC BY-SA 4.0", url: "https://commons.wikimedia.org/wiki/File:Fox.jpg",
    license: "CC BY-SA 4.0", author: "Jane Doe", provider: "Wikimedia Commons" },
  alternatives: [], message: "",
  candidates: [
    { token: "t1", thumbUrl: "data:image/jpeg;base64,AA", title: "Red fox", provider: "Wikimedia Commons", license: "CC BY-SA 4.0", score: 0.9, suitable: true, selected: true },
    { token: "t2", thumbUrl: "data:image/jpeg;base64,AB", title: "Fox in snow", provider: "Openverse", license: "CC BY 2.0", score: 0.8, suitable: true },
  ],
  decision: { mode: "auto", searched: true, generated: false, evaluation: "vision" },
}

describe("visual assistant UI", () => {
  it("draws only the steps that really happen", () => {
    expect(visibleSteps([], "auto").map((s) => s.id)).toEqual(["understanding", "searching", "evaluating", "placing"])
    expect(visibleSteps(["understanding", "searching", "evaluating", "generating"], "auto").map((s) => s.id)).toContain("generating")
    expect(visibleSteps(["understanding", "generating"], "auto").map((s) => s.id)).toEqual(["understanding", "generating", "placing"])
    expect(visibleSteps([], "generate").map((s) => s.id)).toEqual(["understanding", "generating", "placing"])
  })

  it("keeps the source and licence on the board, and labels AI images", () => {
    expect(visualCaption(base)).toBe("Red fox — Source: Jane Doe, CC BY-SA 4.0, Wikimedia Commons")
    expect(visualCaption({ ...base, source: "generated", attribution: null })).toBe("Red fox — AI-generated image")
  })

  it("shows a retrieved image as real, with attribution, and lets the user swap or create instead", () => {
    const onPick = vi.fn(), onGenerate = vi.fn()
    render(<VisualResultCard result={base} busy={false} onShow={vi.fn()} onRemove={vi.fn()} onPick={onPick} onGenerate={onGenerate} onSearch={vi.fn()} onRegenerate={vi.fn()} />)
    expect(screen.getByText(/Real photo/)).toBeTruthy()
    expect(screen.getByText("Source").closest("a")?.getAttribute("href")).toBe("https://commons.wikimedia.org/wiki/File:Fox.jpg")
    fireEvent.click(screen.getByAltText("Fox in snow"))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ token: "t2" }))
    fireEvent.click(screen.getByText(/Create an AI image instead/))
    expect(onGenerate).toHaveBeenCalled()
  })

  it("marks a generated image as AI-generated and offers Regenerate", () => {
    const onRegenerate = vi.fn()
    render(<VisualResultCard result={{ ...base, source: "generated", aiGenerated: true, attribution: null, candidates: [], decision: { ...base.decision, searched: true, generated: true } }}
      busy={false} onShow={vi.fn()} onRemove={vi.fn()} onPick={vi.fn()} onGenerate={vi.fn()} onSearch={vi.fn()} onRegenerate={onRegenerate} />)
    expect(screen.getByText("AI-generated")).toBeTruthy()
    expect(screen.getByText(/It is not a real photograph/)).toBeTruthy()
    fireEvent.click(screen.getByText("Regenerate"))
    expect(onRegenerate).toHaveBeenCalled()
  })

  it("offers only the next steps the server allows when nothing was good enough", () => {
    render(<VisualNoMatchCard result={{ ...base, status: "no_match", imageUrl: null, source: null, message: "No reliable photo of Einstein.", alternatives: ["pick", "rephrase", "diagram"] }}
      busy={false} onPick={vi.fn()} onGenerate={vi.fn()} onSearch={vi.fn()} onRephrase={vi.fn()} onDiagram={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText("No reliable photo of Einstein.")).toBeTruthy()
    expect(screen.queryByText(/Create an AI image/)).toBeNull()
    expect(screen.getByText(/Draw it as a diagram/)).toBeTruthy()
    expect(screen.getByText(/Closest results/)).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ me: { name: "A", email: "a@b.c" }, signOut: vi.fn() }) }))
vi.mock("@/lib/queries", () => ({ useCourses: () => ({ data: [] }) }))
vi.mock("./Sidebar", () => ({ Sidebar: () => <nav aria-label="Main" /> }))
vi.mock("./PageHeader", () => ({ PageHeader: () => <header>header</header> }))

import { AppShell } from "./AppShell"

const shell = (fit?: boolean) => render(<MemoryRouter><AppShell role="student" crumbs={[{ label: "x" }]} fitViewport={fit}><p>body</p></AppShell></MemoryRouter>)
afterEach(() => { cleanup(); Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true }) })

describe("AppShell fitViewport (workspace pages: the page itself must never be taller than the screen)", () => {
  it("is exactly one viewport tall, clips its own overflow, and lets <main> take the remaining height with min-h-0", () => {
    const { container } = shell(true)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain("h-[100dvh]")
    expect(root.className).toContain("overflow-hidden")
    expect(root.className).not.toContain("min-h-[100dvh]")
    expect((root.querySelector(".flex-col") as HTMLElement).className).toContain("min-h-0")
    const main = screen.getByRole("main")
    for (const c of ["flex-1", "min-h-0", "flex-col", "overflow-hidden"]) expect(main.className).toContain(c)
  })
  it("ordinary pages keep the original growing layout (they scroll the page as before)", () => {
    const { container } = shell(false)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain("min-h-[100dvh]")
    expect(root.className).not.toContain("overflow-hidden")
    expect(screen.getByRole("main").className).toContain("p-4")
  })
  it("follows the visual viewport (phone keyboard open) so the composer stays above the keyboard", () => {
    Object.defineProperty(window, "visualViewport", { value: { height: 410.4, addEventListener: vi.fn(), removeEventListener: vi.fn() }, configurable: true })
    const { container } = shell(true)
    expect((container.firstElementChild as HTMLElement).style.height).toBe("410px")
  })
  it("ignores the visual viewport on ordinary pages", () => {
    Object.defineProperty(window, "visualViewport", { value: { height: 410, addEventListener: vi.fn(), removeEventListener: vi.fn() }, configurable: true })
    const { container } = shell(false)
    expect((container.firstElementChild as HTMLElement).style.height).toBe("")
  })
})

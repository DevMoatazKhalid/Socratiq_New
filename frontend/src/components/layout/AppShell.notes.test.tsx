// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ me: { name: "A", email: "a@b.c" }, signOut: vi.fn() }) }))
vi.mock("@/lib/queries", () => ({ useCourses: () => ({ data: [] }) }))
vi.mock("./Sidebar", () => ({ Sidebar: () => <nav aria-label="Main" /> }))
vi.mock("@/components/notes/NotesDrawer", () => ({ default: ({ onClose }: { onClose: () => void }) => <aside aria-label="My notes"><button onClick={onClose}>Close notes</button></aside> }))

import { notesPanel } from "@/lib/notes"
import { AppShell } from "./AppShell"

afterEach(() => { cleanup(); notesPanel.set({ open: false, noteId: null }) })
const shell = (role: "student" | "teacher") => render(<MemoryRouter><AppShell role={role} crumbs={[{ label: "x" }]}><p>body</p></AppShell></MemoryRouter>)

describe("My Notes is a global student action", () => {
  it("appears in the page header for students and opens the panel over the page without navigating", async () => {
    shell("student")
    const btn = screen.getByRole("button", { name: /my notes/i })
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(btn)
    expect(await screen.findByRole("complementary", { name: "My notes" })).toBeTruthy()
    expect(screen.getByText("body")).toBeTruthy()                       // the page is still there
    fireEvent.click(screen.getByText("Close notes"))
    expect(screen.queryByRole("complementary", { name: "My notes" })).toBeNull()
  })
  it("stays open across page changes (each page mounts its own AppShell)", async () => {
    const { unmount } = shell("student")
    fireEvent.click(screen.getByRole("button", { name: /my notes/i }))
    await screen.findByRole("complementary", { name: "My notes" })
    unmount()
    shell("student")
    expect(await screen.findByRole("complementary", { name: "My notes" })).toBeTruthy()
  })
  it("is not shown to instructors", () => {
    shell("teacher")
    expect(screen.queryByRole("button", { name: /my notes/i })).toBeNull()
  })
})

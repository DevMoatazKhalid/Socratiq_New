// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api }))

import { useSetPersona, type PersonaState } from "./queries"

const KEY = ["student", "personas"]
const info = (id: string) => ({ id, version: 1, name: { en: id }, tagline: { en: "t" }, description: { en: "d" }, tone: "x", formality: "balanced" })
const state = (sel: string): PersonaState => ({ personas: ["socratic_guide", "visual_explorer"].map(info), selected: { id: sel, version: 1 }, default: "socratic_guide" })

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData(KEY, state("socratic_guide"))
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return { qc, ...renderHook(() => useSetPersona(), { wrapper }) }
}

describe("useSetPersona", () => {
  it("sends the persona id (and assignment) to the server and ends on the server-confirmed state", async () => {
    api.mockReset(); api.mockResolvedValue(state("visual_explorer"))
    const { qc, result } = setup()
    await act(async () => { await result.current.mutateAsync({ personaId: "visual_explorer", assignmentId: "A1" }) })
    expect(api).toHaveBeenCalledWith("/student/teaching-personas", { method: "PUT", body: { persona_id: "visual_explorer", assignment_id: "A1" } })
    expect(qc.getQueryData<PersonaState>(KEY)!.selected.id).toBe("visual_explorer")
  })

  it("rolls the selection back when the server refuses, so the UI never keeps a false selection", async () => {
    api.mockReset(); api.mockRejectedValue(new Error("nope"))
    const { qc, result } = setup()
    await act(async () => { await result.current.mutateAsync({ personaId: "visual_explorer" }).catch(() => {}) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(qc.getQueryData<PersonaState>(KEY)!.selected.id).toBe("socratic_guide")
    expect(api.mock.calls[0][1].body).toEqual({ persona_id: "visual_explorer" })   // no assignment_id key when none given
  })

  it("does not touch any chat, board or memory cache entry", async () => {
    api.mockReset(); api.mockResolvedValue(state("visual_explorer"))
    const { qc, result } = setup()
    qc.setQueryData(["student", "chat", "A1"], ["kept"])
    await act(async () => { await result.current.mutateAsync({ personaId: "visual_explorer" }) })
    expect(qc.getQueryData(["student", "chat", "A1"])).toEqual(["kept"])
  })
})

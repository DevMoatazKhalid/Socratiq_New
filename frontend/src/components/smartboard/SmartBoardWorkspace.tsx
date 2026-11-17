import "./assetPath"
import "@excalidraw/excalidraw/index.css"
import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, useHandleLibrary } from "@excalidraw/excalidraw"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { Mic, Image as ImageIcon, Play, Sparkles, ChevronDown, Maximize, Minimize } from "lucide-react"
import { cn } from "@/lib/utils"

export const SMARTBOARD_LIBRARY_STORAGE_KEY = "socratiq_smartboard_library_items"

export const localStorageLibraryAdapter = {
  load: async () => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SMARTBOARD_LIBRARY_STORAGE_KEY) : null
      if (!raw) return null
      const parsed = JSON.parse(raw)
      return { libraryItems: Array.isArray(parsed) ? (parsed as LibraryItems) : [] }
    } catch (e) {
      console.warn("[smartboard] failed to load library from localStorage:", e)
      return null
    }
  },
  save: async (libraryData: { libraryItems: LibraryItems }) => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(SMARTBOARD_LIBRARY_STORAGE_KEY, JSON.stringify(libraryData.libraryItems))
      }
    } catch (e) {
      console.warn("[smartboard] failed to save library to localStorage:", e)
    }
  },
}
import { generateDiagram, generateImage, generateSimulation, saveScene, type CoachVisual } from "@/lib/queries"
import { createAutosaver, type SaveState } from "@/lib/smartboard/autosave"
import { planCoachInsertion } from "@/lib/smartboard/coachInsert"
import { parseDiagramSpec } from "@/lib/smartboard/diagramSpec"
import { boardDigest, describeAiError, describeSaveError, isPermanentSaveError, sceneSignature, selectedLegacyId } from "@/lib/smartboard/glue"
import { planAiInsertion } from "@/lib/smartboard/insertAi"
import { planImageInsertion } from "@/lib/smartboard/insertImage"
import { planSimulationInsertion } from "@/lib/smartboard/insertSimulation"
import { legacyBoardToNative, unmirroredCoachElements, type MigrationReport } from "@/lib/smartboard/legacy"
import { readMeta, withMeta } from "@/lib/smartboard/meta"
import { viewportRect } from "@/lib/smartboard/placement"
import { browserImageCompressor, buildStoredScene, compressSceneFiles, isStoredScene, restoreStoredScene, sceneBytes, SCENE_MAX_BYTES } from "@/lib/smartboard/scene"
import type { Rect, SceneEl } from "@/lib/smartboard/types"
import { ASK_ACTIONS, type BoardIntent } from "@/lib/boardAsk"
import { fromServer, type Board, type BoardElement } from "@/lib/whiteboard"
import { LiveVoicePanel } from "./LiveVoicePanel"
import { BoardSimulationLayer } from "./BoardSimulationLayer"
import { isSimulationCard, type SimulationMap, type SimulationRecord } from "@/lib/smartboard/simulationRef"
import { sameViewport, type BoardViewport } from "@/lib/smartboard/simulationLayout"
import { validateSimulationCode } from "@/lib/smartboard/simulationDoc"

/** Same contract as the legacy BoardWorkspace, so the Coach page can use either engine. */
export interface BoardApi {
  flush: () => Promise<boolean>
  applyServer: (b: Partial<Board>) => number
  selectedId: () => string | null
  toggleFullscreen?: () => Promise<void>
  /** Draw a visual the COACH decided on (redeems its server-issued grant). Resolves true when it is on the board. Absent on the legacy engine. */
  runCoachVisual?: (v: CoachVisual) => Promise<boolean>
}
interface Props {
  assignmentId: string
  courseId?: string
  initial: Board
  readOnly?: boolean
  busy: boolean
  onAsk: (intent: BoardIntent, message: string) => void
  /** Where the scene is saved. Defaults to the assignment's whiteboard endpoint; the public demo page overrides it. */
  onPersist?: (scene: unknown) => Promise<unknown>
}

type Els = readonly ExcalidrawElement[]
type AiState =
  | { phase: "idle" }
  | { phase: "working"; step: string }
  | { phase: "done"; message: string; groupId: string; rect: Rect }
  | { phase: "error"; message: string; detail?: string }

type AiMode = "diagram" | "image" | "simulation"

function buildInit(initial: Board) {
  if (initial.scene && isStoredScene(initial.scene)) {
    const r = restoreStoredScene(initial.scene)
    let elements: Els = r.elements, files = r.files as Record<string, BinaryFileData>, dirty = false
    const deletedCoachSet = new Set(r.deletedCoachIds)
    const missing = unmirroredCoachElements(initial, elements, deletedCoachSet)          // the Coach writes server-side: bring anything it wrote since the last save onto the canvas
    if (missing.length) {
      const p = planCoachInsertion({ existing: elements, coach: missing, viewport: null, opId: `load-${initial.nextSeq}` })
      if (p.ok && p.added.length) { elements = p.all; files = { ...files, ...(p.files as Record<string, BinaryFileData>) }; dirty = true }
    }
    return { elements, appState: r.appState, files, dirty, report: null as MigrationReport | null, simulations: r.simulations, deletedCoachIds: r.deletedCoachIds }
  }
  const m = legacyBoardToNative(initial)                                  // existing board: deterministic, non-destructive upgrade (legacy data stays on the server)
  const empty = m.elements.length === 0
  return { elements: m.elements as Els, appState: { viewBackgroundColor: "#ffffff" } as Partial<AppState>, files: m.files as unknown as Record<string, BinaryFileData>, dirty: !empty, report: empty ? null : m.report, simulations: {} as SimulationMap, deletedCoachIds: [] as string[] }
}

const bump = (e: ExcalidrawElement, patch: Partial<ExcalidrawElement>): ExcalidrawElement => ({ ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }) as ExcalidrawElement

const SaveBadge = ({ s, onRetry }: { s: SaveState; onRetry: () => void }) => {
  const label = s.status === "saving" ? "Saving…" : s.status === "dirty" ? "Unsaved changes" : s.status === "saved" ? (s.savedAt ? `Saved ${new Date(s.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Saved") : s.status === "offline" ? "Offline: will retry" : s.status === "error" ? (s.permanent ? "Not saved" : "Save failed: retrying") : ""
  if (!label) return null
  const bad = s.status === "error" || s.status === "offline"
  return (
    <div role="status" aria-live="polite" title={s.error ?? undefined} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs ${bad ? "border-[var(--color-danger-ink)] text-[var(--color-danger-ink)]" : "border-[var(--color-line)] text-[var(--color-ink-muted)]"} bg-white/90`}>
      <span aria-hidden className={`inline-block size-2 rounded-full ${s.status === "saved" ? "bg-emerald-500" : bad ? "bg-red-500" : "bg-amber-400"}`} />
      <span>{label}</span>
      {/* The reason must be readable text, not only a hover tooltip, and a revision conflict cannot be fixed by retrying: it needs a reload. */}
      {s.status === "error" && s.permanent && s.error && <span className="max-w-[16rem] whitespace-normal">{s.error}</span>}
      {s.code === "board_conflict"
        ? <button type="button" onClick={() => window.location.reload()} className="underline">Reload</button>
        : bad && <button type="button" onClick={onRetry} className="underline">Retry now</button>}
    </div>
  )
}

export const SmartBoardWorkspace = forwardRef<BoardApi, Props>(function SmartBoardWorkspace({ assignmentId, courseId, initial, readOnly, busy, onAsk, onPersist }, ref) {
  const [init] = useState(() => buildInit(initial))
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null)
  const [ready, setReady] = useState(false)
  const [initialLibraryItems] = useState<LibraryItems>(() => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SMARTBOARD_LIBRARY_STORAGE_KEY) : null
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as LibraryItems) : []
    } catch {
      return []
    }
  })

  useHandleLibrary({
    excalidrawAPI,
    adapter: localStorageLibraryAdapter,
  })

  useEffect(() => {
    if (typeof window !== "undefined" && !window.name) {
      window.name = "socratiq_whiteboard"
    }
  }, [])

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === SMARTBOARD_LIBRARY_STORAGE_KEY && e.newValue && apiRef.current) {
        try {
          const parsed = JSON.parse(e.newValue)
          if (Array.isArray(parsed)) {
            apiRef.current.updateLibrary({ libraryItems: parsed as LibraryItems, merge: true })
          }
        } catch (err) {
          console.warn("[smartboard] failed to sync library from other tab:", err)
        }
      }
    }
    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [])
  const lastSig = useRef<string | null>(null)
  const coachText = useRef(new Map<string, string>())
  const [compressCache] = useState(() => new Map<string, string>())
  const latest = useRef({ assignmentId, onPersist })
  useEffect(() => { latest.current = { assignmentId, onPersist } })
  const [save, setSave] = useState<SaveState>({ status: "idle", savedAt: null, error: null, permanent: false, retryInMs: null })
  const [hasContent, setHasContent] = useState(init.elements.some((e) => !e.isDeleted))
  const [ai, setAi] = useState<AiState>({ phase: "idle" })
  const [aiMode, setAiMode] = useState<AiMode>("diagram")
  const [prompt, setPrompt] = useState("")
  const [notice, setNotice] = useState<string | null>(init.report?.warnings.length ? `Your board was upgraded to the new whiteboard. ${init.report.warnings.slice(0, 2).join(" ")}` : null)
  const [showLiveVoice, setShowLiveVoice] = useState(false)
  // Simulation source lives beside the elements (like image files) and is saved with the scene. The ref is the write-through copy the autosaver reads.
  const simsRef = useRef<SimulationMap>(init.simulations)
  const [sims, setSims] = useState<SimulationMap>(init.simulations)
  const [simCards, setSimCards] = useState<ExcalidrawElement[]>([])
  const simSig = useRef("")
  const [viewport, setViewport] = useState<BoardViewport>({ scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 })
  const [simInteractive, setSimInteractive] = useState(true)
  const aiBusy = useRef(false)

  const knownCoachIdsRef = useRef<Set<string>>(new Set([
    ...(initial.elements ?? []).filter((e) => e.author === "coach").map((e) => e.id),
    ...(init.elements ?? []).map((e) => (e.customData?.socratiq as { legacyId?: string } | undefined)?.legacyId).filter((id): id is string => typeof id === "string"),
  ]))
  const deletedCoachIdsRef = useRef<Set<string>>(new Set(init.deletedCoachIds ?? []))
  const sceneRev = useRef<number>(initial.sceneRev ?? 0)       // the server revision this tab's copy is based on
  const [saver] = useState(() => createAutosaver({
    save: async () => {
      const api = apiRef.current
      if (!api) return
      const allEls = api.getSceneElementsIncludingDeleted()
      const liveCoach = new Set<string>()
      for (const e of allEls) {
        if (!e.isDeleted) {
          const legacyId = (e.customData?.socratiq as { legacyId?: string } | undefined)?.legacyId
          if (legacyId) {
            liveCoach.add(legacyId)
            knownCoachIdsRef.current.add(legacyId)
          }
        } else {
          const legacyId = (e.customData?.socratiq as { legacyId?: string } | undefined)?.legacyId
          if (legacyId) deletedCoachIdsRef.current.add(legacyId)
        }
      }
      for (const id of knownCoachIdsRef.current) {
        if (!liveCoach.has(id)) {
          deletedCoachIdsRef.current.add(id)
        }
      }
      const stored = buildStoredScene(allEls, api.getAppState(), api.getFiles(), simsRef.current, Array.from(deletedCoachIdsRef.current))
      if (stored.deletedCoachIds) {
        for (const id of stored.deletedCoachIds) deletedCoachIdsRef.current.add(id)
      }
      const small = await compressSceneFiles(stored, browserImageCompressor, compressCache)
      if (sceneBytes(small) > SCENE_MAX_BYTES) throw Object.assign(new Error("The board is too large to save. Remove some images or very large drawings."), { permanent: true })
      const { assignmentId: id, onPersist: persist } = latest.current
      if (persist) { await persist(small); return }
      const saved = await saveScene(id, small, sceneRev.current)
      sceneRev.current = typeof saved.sceneRev === "number" ? saved.sceneRev : sceneRev.current + 1
    },
    isOffline: () => typeof navigator !== "undefined" && !navigator.onLine,
    isPermanent: (e) => isPermanentSaveError(e) || !!(e as { permanent?: boolean }).permanent,
    describe: (e) => ((e as { permanent?: boolean }).permanent ? (e as Error).message : describeSaveError(e)),
  }))
  useEffect(() => saver.subscribe(setSave), [saver])
  // Flush on the way out, then dispose, but only if we are STILL unmounted when the flush finishes. React (StrictMode in development, Fast Refresh)
  // runs this cleanup and immediately re-mounts the same component with the same saver; disposing it then would silently kill autosave.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void saver.flush().finally(() => { if (!mountedRef.current) saver.dispose() })
    }
  }, [saver])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { const s = saver.getState().status; if (s === "dirty" || s === "saving" || s === "error" || s === "offline") { e.preventDefault(); e.returnValue = "" } }
    const hide = () => { if (document.visibilityState === "hidden") void saver.flush() }
    window.addEventListener("beforeunload", warn); document.addEventListener("visibilitychange", hide)
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("visibilitychange", hide) }
  }, [saver])


  const containerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isCssFullscreen, setIsCssFullscreen] = useState(false)

  useEffect(() => {
    const handleFsChange = () => {
      const fs = Boolean(document.fullscreenElement)
      setIsFullscreen(fs)
      if (!fs) setIsCssFullscreen(false)
      setTimeout(() => window.dispatchEvent(new Event("resize")), 100)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isCssFullscreen) {
        setIsCssFullscreen(false)
        setTimeout(() => window.dispatchEvent(new Event("resize")), 100)
      }
    }
    document.addEventListener("fullscreenchange", handleFsChange)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("fullscreenchange", handleFsChange)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isCssFullscreen])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement && !isCssFullscreen) {
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen()
        } else {
          setIsCssFullscreen(true)
        }
      } else {
        if (document.fullscreenElement && document.exitFullscreen) {
          await document.exitFullscreen()
        }
        setIsCssFullscreen(false)
      }
    } catch {
      setIsCssFullscreen((prev) => !prev)
    }
    setTimeout(() => window.dispatchEvent(new Event("resize")), 150)
  }, [isCssFullscreen])

  const scrollTo = useCallback((els: Els) => { apiRef.current?.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true, duration: 450, maxZoom: 1 }) }, [])
  const currentViewport = () => { const a = apiRef.current!.getAppState(); return viewportRect(a) }

  useImperativeHandle(ref, () => ({
    flush: () => saver.flush(),
    selectedId: () => { const api = apiRef.current; return api ? selectedLegacyId(api.getSceneElementsIncludingDeleted() as readonly SceneEl[], api.getAppState().selectedElementIds) : null },
    toggleFullscreen,
    runCoachVisual: (v) => (readOnly ? Promise.resolve(false) : v.kind === "diagram" ? runAiDiagram(v.request, { grant: v.grant, explore: v.explorePrompt }) : runAiSimulation(v.request, { grant: v.grant, explore: v.explorePrompt })),
    applyServer: (b) => {
      const api = apiRef.current
      if (!api) return 0
      for (const e of b.elements ?? []) {
        if (e.author === "coach") knownCoachIdsRef.current.add(e.id)
      }
      const els = api.getSceneElementsIncludingDeleted()
      const missing = unmirroredCoachElements(fromServer(b), els, deletedCoachIdsRef.current)
      if (!missing.length) return 0
      const p = planCoachInsertion({ existing: els, coach: missing, viewport: currentViewport(), opId: `coach-${Date.now()}` })
      if (!p.ok) { console.warn("[smartboard] could not place the Coach's drawing safely:", p.reason, p.diagnostics); return 0 }
      const files = Object.values(p.files) as BinaryFileData[]
      if (files.length) api.addFiles(files)
      api.updateScene({ elements: p.all, appState: { selectedElementIds: {}, selectedGroupIds: { [p.groupId]: true } } as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      const vp = currentViewport()
      if (p.rect.x < vp.x || p.rect.y < vp.y || p.rect.x + p.rect.w > vp.x + vp.w || p.rect.y + p.rect.h > vp.y + vp.h) scrollTo(p.added)
      return missing.length
    },
  }), [saver, scrollTo, toggleFullscreen])

  const onChange = useCallback((elements: Els, appState?: AppState) => {
    setHasContent(elements.some((e) => !e.isDeleted))
    const liveCoachIds = new Set<string>()
    for (const e of elements) {
      if (!e.isDeleted) {
        const legacyId = (e.customData?.socratiq as { legacyId?: string } | undefined)?.legacyId
        if (legacyId) {
          liveCoachIds.add(legacyId)
          knownCoachIdsRef.current.add(legacyId)
        }
      } else {
        const legacyId = (e.customData?.socratiq as { legacyId?: string } | undefined)?.legacyId
        if (legacyId) deletedCoachIdsRef.current.add(legacyId)
      }
    }
    for (const id of knownCoachIdsRef.current) {
      if (!liveCoachIds.has(id)) {
        deletedCoachIdsRef.current.add(id)
      }
    }

    // Feed the simulation layer: which cards exist and where the board is looking. Updated only when something it draws actually changed.
    // Excalidraw MUTATES elements in place while dragging/resizing, so object identity and even `version` comparisons against the previous array see
    // "no change". Compare a value signature, and hand the layer fresh copies so its memoised cards re-render when a card moves or is resized.
    const cards = elements.filter(isSimulationCard)
    const cardSig = cards.map((c) => `${c.id}:${c.version}:${c.x}:${c.y}:${c.width}:${c.height}:${c.angle}`).join("|")
    if (cardSig !== simSig.current) { simSig.current = cardSig; setSimCards(cards.map((c) => ({ ...c }))) }
    const st = appState ?? apiRef.current?.getAppState()
    if (st) {
      const v: BoardViewport = { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value, width: st.width, height: st.height }
      setViewport((prev) => (sameViewport(prev, v) ? prev : v))
      const tool = st.activeTool?.type
      setSimInteractive(tool === "selection" || tool === "hand" || !tool)
    }

    if (readOnly) return
    const sig = sceneSignature(elements)
    if (lastSig.current === null) { lastSig.current = sig; for (const e of elements) if (e.type === "text" && readMeta(e)?.author === "coach") coachText.current.set(e.id, e.text); return }
    if (sig === lastSig.current) return
    lastSig.current = sig
    // If the student edits what the Coach wrote, it becomes the student's content (with provenance), mirroring the legacy board's rule.
    const edited = elements.filter((e) => e.type === "text" && !e.isDeleted && readMeta(e)?.author === "coach" && coachText.current.has(e.id) && coachText.current.get(e.id) !== e.text)
    if (edited.length && apiRef.current) {
      const ids = new Set(edited.map((e) => e.id))
      edited.forEach((e) => coachText.current.delete(e.id))
      apiRef.current.updateScene({ elements: elements.map((e) => (ids.has(e.id) ? bump(e, { customData: withMeta(e.customData, { author: "student", originalAuthor: "coach", legacyId: readMeta(e)?.legacyId, role: readMeta(e)?.role }) }) : e)), captureUpdate: CaptureUpdateAction.NEVER })
    }
    saver.markDirty()
  }, [readOnly, saver])

  useEffect(() => { if (ready && init.dirty && !readOnly) saver.markDirty() }, [ready, init.dirty, readOnly, saver])

  const runAiDiagram = useCallback(async (text: string, opts?: { grant?: string; explore?: string }): Promise<boolean> => {
    const api = apiRef.current
    const request = text.trim()
    if (!api || !request || aiBusy.current || readOnly) return false
    aiBusy.current = true
    setNotice(null)
    setAi({ phase: "working", step: "Understanding your request…" })
    const opId = crypto.randomUUID()
    try {
      const before = api.getSceneElementsIncludingDeleted()
      const selected = Object.keys(api.getAppState().selectedElementIds)
      const { spec } = await generateDiagram({ request, board: boardDigest(before as readonly SceneEl[]), selectedId: selected[0] ?? null, assignmentId, grant: opts?.grant ?? null })
      setAi({ phase: "working", step: "Finding space on your board…" })
      const parsed = parseDiagramSpec(spec)
      if (!parsed.ok) throw new Error("The drawing plan was incomplete.")
      const els = api.getSceneElementsIncludingDeleted()
      const plan = planAiInsertion({ spec: parsed.spec, request, elements: els, viewport: currentViewport(), selectedIds: Object.keys(api.getAppState().selectedElementIds), opId })
      if (!plan.ok) { console.warn("[smartboard] AI drawing rejected:", plan.reason, plan.diagnostics); setAi({ phase: "error", message: plan.message, detail: plan.diagnostics.slice(-4).join("\n") }); return false }
      if (plan.duplicate) { setAi({ phase: "idle" }); return false }
      api.updateScene({ elements: plan.all, appState: { selectedElementIds: {}, selectedGroupIds: { [plan.groupId]: true } } as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      if (!plan.visible) scrollTo(plan.added)
      const where = plan.placement.strategy === "anchor" ? "next to your content" : plan.placement.strategy === "empty-board" ? "on your board" : plan.placement.strategy === "extend" ? "in free space beyond your content" : "in free space"
      setAi({ phase: "done", message: `Added “${parsed.spec.title ?? parsed.spec.topic}” ${where}. Ctrl+Z removes it in one step.${opts?.explore ? ` ${opts.explore}` : ""}`, groupId: plan.groupId, rect: plan.rect })
      setPrompt("")
      return true
    } catch (e) {
      setAi({ phase: "error", message: describeAiError(e) })
      return false
    } finally { aiBusy.current = false }
  }, [readOnly, scrollTo])

  const runAiImage = useCallback(async (text: string) => {
    const api = apiRef.current
    const request = text.trim()
    if (!api || !request || aiBusy.current || readOnly) return
    aiBusy.current = true
    setNotice(null)
    setAi({ phase: "working", step: "Generating illustration with AI…" })
    const opId = crypto.randomUUID()
    try {
      const { imageUrl } = await generateImage(request, "1K", assignmentId)
      setAi({ phase: "working", step: "Finding space on your board…" })
      const els = api.getSceneElementsIncludingDeleted()
      const plan = planImageInsertion({
        imageDataUrl: imageUrl,
        prompt: request,
        elements: els,
        viewport: currentViewport(),
        selectedIds: Object.keys(api.getAppState().selectedElementIds),
        opId,
      })
      if (!plan.ok) {
        setAi({ phase: "error", message: plan.message })
        return
      }
      api.addFiles([plan.file])
      api.updateScene({
        elements: plan.all,
        appState: { selectedElementIds: {}, selectedGroupIds: { [plan.groupId]: true } } as never,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      if (!plan.visible) scrollTo(plan.added)
      setAi({ phase: "done", message: `Added image for “${request}”. Ctrl+Z removes it.`, groupId: plan.groupId, rect: plan.rect })
      setPrompt("")
    } catch (e) {
      setAi({ phase: "error", message: describeAiError(e) })
    } finally { aiBusy.current = false }
  }, [readOnly, scrollTo])

  /** The ONE way a simulation gets onto the board (AI generation and the Live Voice tool both end here). Idempotent per simulation id. */
  const insertSimulationCard = useCallback((sim: SimulationRecord): { ok: true } | { ok: false; message: string } => {
    const api = apiRef.current
    if (!api) return { ok: false, message: "The board is not ready yet." }
    if (simsRef.current[sim.id]) return { ok: true }
    // Never let unsafe or oversized code into the scene: the server would reject the WHOLE board on save (the same failure that pinning used to cause).
    const verdict = validateSimulationCode(sim.code)
    if (!verdict.safe) return { ok: false, message: `This simulation was not added: ${verdict.violations.join(", ")}.` }
    const els = api.getSceneElementsIncludingDeleted()
    const plan = planSimulationInsertion({ simulation: sim, elements: els, viewport: currentViewport(), opId: crypto.randomUUID() })
    if (!plan.ok) return { ok: false, message: plan.message }
    simsRef.current = { ...simsRef.current, [sim.id]: sim }
    setSims(simsRef.current)
    api.updateScene({
      elements: plan.all,
      appState: { selectedElementIds: { [plan.added[0].id]: true } } as never,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    scrollTo(plan.added)
    return { ok: true }
  }, [scrollTo])

  useEffect(() => {                                       // Live Voice tool calls arrive as a window event; they use the same path as the Simulate button
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (readOnly || !d || typeof d.id !== "string" || typeof d.code !== "string") return
      const r = insertSimulationCard({ id: d.id, title: String(d.title ?? "Simulation").slice(0, 120), code: d.code })
      if (!r.ok) setNotice(r.message)
    }
    window.addEventListener("socratiq-open-simulation", handler)
    return () => window.removeEventListener("socratiq-open-simulation", handler)
  }, [readOnly, insertSimulationCard])

  const removeSimulationCard = useCallback((id: string) => {
    const api = apiRef.current
    if (!api) return
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => (e.id === id && !e.isDeleted ? bump(e, { isDeleted: true }) : e)), captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }, [])

  const runAiSimulation = useCallback(async (text: string, opts?: { grant?: string; explore?: string }): Promise<boolean> => {
    const request = text.trim()
    if (!request || aiBusy.current || readOnly) return false
    aiBusy.current = true
    setNotice(null)
    setAi({ phase: "working", step: "Building interactive simulation…" })
    try {
      const { code } = await generateSimulation(request, undefined, assignmentId, opts?.grant ?? null)
      const placed = insertSimulationCard({ id: crypto.randomUUID(), title: request.slice(0, 120), code })
      if (!placed.ok) { setAi({ phase: "error", message: placed.message }); return false }
      setAi({ phase: "idle" })
      if (opts?.explore) setNotice(`SocratiQ added an interactive simulation to your board. ${opts.explore}`)
      setPrompt("")
      return true
    } catch (e) {
      setAi({ phase: "error", message: describeAiError(e) })
      return false
    } finally { aiBusy.current = false }
  }, [readOnly, insertSimulationCard])

  const handleSubmit = useCallback((text: string) => {
    if (aiMode === "image") {
      void runAiImage(text)
    } else if (aiMode === "simulation") {
      void runAiSimulation(text)
    } else {
      void runAiDiagram(text)
    }
  }, [aiMode, runAiDiagram, runAiImage, runAiSimulation])

  const removeAiGroup = (groupId: string) => {
    const api = apiRef.current
    if (!api) return
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => (e.groupIds.includes(groupId) && !e.isDeleted ? bump(e, { isDeleted: true }) : e)), captureUpdate: CaptureUpdateAction.IMMEDIATELY })
    setAi({ phase: "idle" })
  }
  const fit = () => apiRef.current?.scrollToContent(undefined, { fitToContent: true, animate: true, duration: 400, maxZoom: 1 })
  const resetView = () => apiRef.current?.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } as never })
  const working = ai.phase === "working"
  const locked = !!readOnly || busy                       // while the Coach is writing, the board is read-only so nothing it writes can collide with an edit
  // Excalidraw hides its top-right UI in view mode, so while the board is locked (Coach writing, or read-only) the status moves to our own overlay.
  const status = (
    <>
      {!readOnly && <SaveBadge s={save} onRetry={() => void saver.flush()} />}
    </>
  )
  const lang = typeof document !== "undefined" && document.documentElement.lang.startsWith("ar") ? "ar-SA" : "en"

  const activeFullscreen = isFullscreen || isCssFullscreen

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full min-h-[320px] w-full bg-white", isCssFullscreen && "fixed inset-0 z-50 h-screen w-screen")}
      data-testid="smartboard"
    >
      <Excalidraw
        excalidrawAPI={(a) => {
          apiRef.current = a
          setExcalidrawAPI(a)
          setReady(true)
        }}
        initialData={{
          elements: init.elements as ExcalidrawElement[],
          appState: init.appState,
          files: init.files,
          libraryItems: initialLibraryItems,
          scrollToContent: true,
        }}
        onChange={onChange}
        onLibraryChange={(items) => {
          try {
            if (typeof localStorage !== "undefined") {
              localStorage.setItem(SMARTBOARD_LIBRARY_STORAGE_KEY, JSON.stringify(items))
            }
          } catch (e) {
            console.warn("[smartboard] failed to persist library on change:", e)
          }
        }}
        libraryReturnUrl={typeof window !== "undefined" ? window.location.origin + window.location.pathname : undefined}
        viewModeEnabled={locked}
        langCode={lang}
        handleKeyboardGlobally={false}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true }, toggleTheme: true } }}
        renderTopRightUI={() => (
          <div className="flex items-center gap-2">
            {status}
            {!readOnly && (
              <button
                type="button"
                onClick={() => setShowLiveVoice((v) => !v)}
                aria-label="Connect Gemini Live Voice"
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                  showLiveVoice
                    ? "border-teal-600 bg-teal-50 text-teal-700 font-medium"
                    : "border-slate-200 bg-white/90 hover:bg-slate-50 text-slate-700 hover:text-slate-900"
                }`}
                title="Start real-time Gemini voice conversation with board vision"
              >
                <Mic className="size-3.5 text-teal-600" />
                <span>{showLiveVoice ? "Voice Active" : "Live Voice"}</span>
              </button>
            )}
            <button type="button" onClick={fit} className="rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors" title="Zoom to fit everything on the board">Fit to content</button>
            <button type="button" onClick={resetView} className="rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors" title="Back to 100% at the origin">Reset view</button>
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors shadow-sm"
              title={activeFullscreen ? (lang === "ar-SA" ? "إنهاء ملء الشاشة" : "Exit full screen") : (lang === "ar-SA" ? "ملء الشاشة" : "Full screen")}
              aria-label={activeFullscreen ? "Exit full screen" : "Full screen"}
            >
              {activeFullscreen ? <Minimize className="size-3.5 text-teal-600" /> : <Maximize className="size-3.5 text-teal-600" />}
              <span>{activeFullscreen ? (lang === "ar-SA" ? "تصغير" : "Exit") : (lang === "ar-SA" ? "ملء الشاشة" : "Full screen")}</span>
            </button>
          </div>
        )}
      >
        {/* An explicit menu: the stock one also carries GitHub / "Follow us" / Discord links, which do not belong in a classroom product. */}
        <MainMenu>
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        {!hasContent && (
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>Your thinking space</WelcomeScreen.Center.Heading>
              <p className="max-w-sm text-center text-sm text-[var(--color-ink-muted)]">Draw, write and sketch freely. Ask the AI to draw a diagram, generate an illustration, create interactive simulations, or talk in real-time with Live Voice.</p>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        )}
      </Excalidraw>

      {/* Floating Live Voice Panel */}
      {showLiveVoice && (
        <div className="absolute right-4 top-14 z-20">
          <LiveVoicePanel
            api={apiRef.current}
            assignmentId={assignmentId}
            courseId={courseId}
            onClose={() => setShowLiveVoice(false)}
          />
        </div>
      )}

      {/* Simulations render INSIDE the board: positioned by the board's own scroll/zoom, clipped to it, managed as board elements. */}
      <BoardSimulationLayer elements={simCards} records={sims} viewport={viewport} interactive={simInteractive || locked} readOnly={locked} onRemove={removeSimulationCard} />

      {/* Centered live writing banner: never collides with top-right or top-left tools */}
      {busy && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-auto absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full border border-teal-200 bg-white/95 px-4 py-1.5 text-xs font-medium text-teal-800 shadow-md backdrop-blur transition-all"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-600" />
          </span>
          <span>{lang === "ar-SA" ? "سقراطيك يكتب على اللوحة الآن…" : "SocratiQ is writing on the board…"}</span>
        </div>
      )}

      {notice && (
        <div role="status" className="absolute left-1/2 top-16 z-10 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-[var(--color-line)] bg-white px-3 py-2 text-xs shadow">
          {notice} <button type="button" onClick={() => setNotice(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {!readOnly && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-10 flex w-[min(960px,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2 md:bottom-3 md:left-[15.5rem] md:right-16 md:mx-auto md:w-auto md:max-w-[960px] md:translate-x-0">
          {(ai.phase !== "idle") && (
            <div role={ai.phase === "error" ? "alert" : "status"} aria-live="polite" className={`pointer-events-auto rounded-lg border px-3 py-2 text-xs shadow ${ai.phase === "error" ? "border-[var(--color-danger-ink)] bg-white text-[var(--color-danger-ink)]" : "border-[var(--color-line)] bg-white"}`}>
              {ai.phase === "working" && <span>{ai.step}</span>}
              {ai.phase === "done" && (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{ai.message}</span>
                  <button type="button" className="underline" onClick={() => { const api = apiRef.current; if (api) scrollTo(api.getSceneElementsIncludingDeleted().filter((e) => e.groupIds.includes(ai.groupId))) }}>Show</button>
                  <button type="button" className="underline" onClick={() => removeAiGroup(ai.groupId)}>Remove</button>
                </span>
              )}
              {ai.phase === "error" && <span>{ai.message}{ai.detail && <details className="mt-1 text-[var(--color-ink-muted)]"><summary className="cursor-pointer">Details</summary><pre className="whitespace-pre-wrap">{ai.detail}</pre></details>}</span>}
            </div>
          )}
          <div className="pointer-events-auto flex items-center gap-1.5 sm:gap-2 rounded-2xl border border-slate-200 bg-white/95 p-1.5 sm:p-2 shadow-lg backdrop-blur-sm overflow-x-auto thin-scroll max-w-full">
            {/* Mode Selector Toggle */}
            <div className="flex items-center shrink-0 rounded-lg border border-slate-200 bg-slate-100/90 p-0.5 text-xs font-medium overflow-hidden">
              <button
                type="button"
                onClick={() => setAiMode("diagram")}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  aiMode === "diagram"
                    ? "bg-white text-teal-800 shadow-sm border border-slate-200/60 font-semibold"
                    : "text-slate-600 hover:text-teal-900 hover:bg-white/80 active:bg-teal-50/70"
                }`}
                title="AI draws vector diagrams on the board"
              >
                Diagram
              </button>
              <button
                type="button"
                onClick={() => setAiMode("image")}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  aiMode === "image"
                    ? "bg-white text-teal-800 shadow-sm border border-slate-200/60 font-semibold"
                    : "text-slate-600 hover:text-teal-900 hover:bg-white/80 active:bg-teal-50/70"
                }`}
                title="AI generates illustrations and images"
              >
                <ImageIcon className="size-3" />
                <span>Image</span>
              </button>
              <button
                type="button"
                onClick={() => setAiMode("simulation")}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  aiMode === "simulation"
                    ? "bg-white text-teal-800 shadow-sm border border-slate-200/60 font-semibold"
                    : "text-slate-600 hover:text-teal-900 hover:bg-white/80 active:bg-teal-50/70"
                }`}
                title="AI creates interactive HTML/JS simulations"
              >
                <Play className="size-3" />
                <span>Simulate</span>
              </button>
            </div>

            <label className="sr-only" htmlFor="smartboard-ai">Ask the AI to draw or explain on your board</label>
            <input
              id="smartboard-ai"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={working}
              maxLength={1000}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  handleSubmit(prompt)
                }
              }}
              placeholder={
                aiMode === "diagram"
                  ? "Ask AI to draw a diagram… (uses selected items)"
                  : aiMode === "image"
                  ? "Describe an image or visual illustration to generate…"
                  : "Describe a physics, math, or logic simulation to create…"
              }
              dir="auto"
              className="min-w-[8rem] sm:min-w-[10rem] flex-1 rounded-lg border border-slate-200 bg-white px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-800 outline-none hover:border-slate-300 focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 transition-all"
            />
            <button
              type="button"
              disabled={working || !prompt.trim()}
              onClick={() => handleSubmit(prompt)}
              className="shrink-0 whitespace-nowrap rounded-lg bg-[var(--color-brand,#0f766e)] px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-white shadow-sm hover:bg-teal-700 hover:shadow active:scale-[0.97] active:bg-teal-800 disabled:opacity-50 disabled:pointer-events-none transition-all"
            >
              {working ? "Working…" : aiMode === "diagram" ? "Draw" : aiMode === "image" ? "Generate" : "Simulate"}
            </button>
            <button
              type="button"
              disabled={busy || !prompt.trim()}
              onClick={() => { onAsk("explain", prompt.trim()); setPrompt("") }}
              className="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-slate-700 shadow-sm hover:border-teal-300 hover:bg-teal-50/80 hover:text-teal-900 active:bg-teal-100 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none transition-all"
              title="Ask the Socratic Coach instead; it guides you with questions"
            >
              Ask Coach
            </button>
            <details className="relative shrink-0">
              <summary className="cursor-pointer list-none whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-slate-700 shadow-sm hover:border-teal-300 hover:bg-teal-50/80 hover:text-teal-900 active:bg-teal-100 active:scale-[0.97] transition-all" aria-label="Ask SocratiQ about the board">Ask SocratiQ ▾</summary>
              <div role="menu" className="absolute bottom-full right-0 mb-2 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                {ASK_ACTIONS.map((a) => (
                  <button key={a.intent} type="button" role="menuitem" disabled={busy} className="block w-full rounded-lg px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-teal-50 hover:text-teal-900 active:bg-teal-100 disabled:opacity-50 transition-colors"
                    onClick={(e) => { const hasSel = Object.keys(apiRef.current?.getAppState().selectedElementIds ?? {}).length > 0; e.currentTarget.closest("details")?.removeAttribute("open"); onAsk(a.intent, a.message(hasSel)) }}>{a.label}</button>
                ))}
              </div>
            </details>
          </div>
        </div>
      )}
    </div>
  )
})

export default SmartBoardWorkspace

/**
 * Renders every simulation card of the native board as a LIVE, sandboxed simulation INSIDE the board.
 *
 * The card itself is a normal Excalidraw rectangle (selectable, draggable, resizable, deletable, persisted like any element). This layer sits
 * over the canvas inside the board container and, for each card, draws the simulation at the card's scene position using the board's own
 * viewport (scroll + zoom), so it pans, zooms and moves with the board and is clipped at the board's edge. It is not a page-level panel.
 *
 * Pointer events: the layer and each card's title bar let events through to the canvas, so the card is selected/dragged by its title bar and
 * border exactly like any other element; only the buttons and the simulation body capture the pointer, and the body only while the select/hand
 * tool is active (so drawing across a simulation with the pen still draws).
 *
 * Lifecycle: the iframe is keyed by (card id, reset count). Removing the card unmounts it and the browser destroys its document, ending every
 * loop. Cards that are off screen or in a hidden tab are paused through the runtime's virtual clock, and resumed when visible again.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Maximize2, Minimize2, Pause, Play, RotateCcw, X } from "lucide-react"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { buildSimulationSrcDoc, SIMULATION_SANDBOX, validateSimulationCode } from "@/lib/smartboard/simulationDoc"
import { controlMessage, parseSimMessage, SIM_SPEEDS } from "@/lib/smartboard/simulationRuntime"
import { isOffscreen, SIM_HEADER_H, toScreenBox, type BoardViewport } from "@/lib/smartboard/simulationLayout"
import { isSimulationCard, resolveSimulation, simulationRefId, type SimulationMap } from "@/lib/smartboard/simulationRef"

/** A simulation that has not reported `loaded` by now is treated as failed to start (a slow CDN no longer blocks it, so this is a real fault). */
export const SIM_START_TIMEOUT_MS = 12_000

type Status = "loading" | "running" | "failed"

interface Props {
  elements: readonly ExcalidrawElement[]
  records: SimulationMap
  viewport: BoardViewport
  /** True while the select or hand tool is active: only then may the simulation body take the pointer. */
  interactive: boolean
  readOnly?: boolean
  onRemove?: (elementId: string) => void
}

function SimulationCard({ el, record, viewport, interactive, readOnly, onRemove, focused, onFocusToggle }: {
  el: ExcalidrawElement; record: ReturnType<typeof resolveSimulation>; viewport: BoardViewport; interactive: boolean; readOnly?: boolean
  onRemove?: (id: string) => void; focused: boolean; onFocusToggle: (id: string | null) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [nonce, setNonce] = useState(0)
  const [status, setStatus] = useState<Status>("loading")
  const [problem, setProblem] = useState<string | null>(null)
  const [tabHidden, setTabHidden] = useState(typeof document !== "undefined" && document.hidden)

  const verdict = useMemo(() => (record ? validateSimulationCode(record.code) : null), [record])
  const blocked = verdict && !verdict.safe ? verdict.violations.join(", ") : null
  const srcDoc = useMemo(() => (record && !blocked ? buildSimulationSrcDoc(record.code) : ""), [record, blocked])

  const box = toScreenBox(el, viewport)
  const offscreen = isOffscreen(box, viewport)
  const hidden = offscreen || tabHidden

  const send = useCallback((c: Parameters<typeof controlMessage>[0]) => { frame.current?.contentWindow?.postMessage(controlMessage(c), "*") }, [])

  // Messages from THIS card's frame only (event.source is the unforgeable origin of a message; the frame's origin is opaque, so origin checks are useless).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = parseSimMessage(e.data)
      if (!m) return
      if (m.type === "loaded") { setStatus("running"); send({ paused, speed, hidden }) }
      else if (m.type === "error" || m.type === "violation") { setProblem((p) => p ?? m.message); if (m.type === "error") setStatus((s) => (s === "loading" ? "failed" : s)) }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [send, paused, speed, hidden])

  useEffect(() => { const f = () => setTabHidden(document.hidden); document.addEventListener("visibilitychange", f); return () => document.removeEventListener("visibilitychange", f) }, [])
  useEffect(() => { send({ paused }) }, [paused, send])
  useEffect(() => { send({ speed }) }, [speed, send])
  useEffect(() => { send({ hidden }) }, [hidden, send])

  useEffect(() => {
    if (!srcDoc || status !== "loading") return
    const t = setTimeout(() => { setStatus((s) => (s === "loading" ? "failed" : s)); setProblem((p) => p ?? "The simulation did not start.") }, SIM_START_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [srcDoc, status, nonce])

  useEffect(() => { if (!focused) return; const k = (e: KeyboardEvent) => e.key === "Escape" && onFocusToggle(null); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k) }, [focused, onFocusToggle])

  const reset = () => { setNonce((n) => n + 1); setPaused(false); setSpeed(1); setStatus("loading"); setProblem(null) }
  const title = record?.title || (el.customData as any)?.simulationRef?.title || "Simulation"

  const style: React.CSSProperties = focused
    ? { position: "absolute", inset: 0, zIndex: 5 }
    : { position: "absolute", left: 0, top: 0, width: el.width, height: el.height, transformOrigin: "0 0", transform: `translate(${box.left}px, ${box.top}px) scale(${viewport.zoom})`, display: offscreen ? "none" : undefined }

  const btn = "pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
  return (
    <div data-sim-card={el.id} data-status={status} data-paused={paused} data-focused={focused} style={{ ...style, pointerEvents: "none" }} className="text-slate-900">
      <div className="flex items-center gap-1 px-2" style={{ height: SIM_HEADER_H, pointerEvents: "none" }} data-sim-header>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-teal-900" title={title}>{title}</span>
        {!blocked && record && <>
          <button type="button" className={btn} aria-label={paused ? "Play simulation" : "Pause simulation"} data-sim-action="toggle" onClick={() => setPaused((p) => !p)}>{paused ? <Play size={16} /> : <Pause size={16} />}</button>
          <button type="button" className={btn} aria-label="Reset simulation" data-sim-action="reset" onClick={reset}><RotateCcw size={16} /></button>
          <select aria-label="Simulation speed" data-sim-action="speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="pointer-events-auto h-7 rounded-md border border-slate-300 bg-white px-1 text-xs text-slate-700">
            {SIM_SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </>}
        <button type="button" className={btn} aria-label={focused ? "Exit full view" : "Enlarge simulation"} data-sim-action="focus" onClick={() => onFocusToggle(focused ? null : el.id)}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        {!readOnly && onRemove && <button type="button" className={btn} aria-label="Remove simulation from board" data-sim-action="remove" onClick={() => onRemove(el.id)}><X size={16} /></button>}
      </div>
      <div className="relative bg-white" style={{ position: "absolute", left: 4, right: 4, top: SIM_HEADER_H, bottom: 4, borderRadius: 6, overflow: "hidden" }}>
        {record && !blocked ? (
          <iframe
            key={`${el.id}:${nonce}`} ref={frame} title={title} data-sim-frame={el.id}
            sandbox={SIMULATION_SANDBOX} srcDoc={srcDoc} referrerPolicy="no-referrer"
            style={{ width: "100%", height: "100%", border: 0, display: "block", pointerEvents: interactive || focused ? "auto" : "none" }}
          />
        ) : (
          <div data-sim-message className="flex h-full items-center justify-center p-4 text-center text-sm text-slate-600">
            {blocked ? `This simulation was blocked: ${blocked}` : "This simulation's data is missing from the board."}
          </div>
        )}
        {status === "loading" && srcDoc && <div className="pointer-events-none absolute inset-x-0 top-0 bg-teal-50 px-2 py-1 text-xs text-teal-800">Starting simulation…</div>}
        {problem && (
          <div role="alert" data-sim-error className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-start gap-2 bg-red-50 px-2 py-1 text-xs text-red-800">
            <span className="min-w-0 flex-1">{status === "failed" ? "The simulation could not run: " : "Problem inside the simulation: "}{problem}</span>
            <button type="button" className="shrink-0 rounded border border-red-300 bg-white px-1.5 py-0.5 hover:bg-red-100" onClick={reset}>Reload</button>
          </div>
        )}
      </div>
    </div>
  )
}

const MemoCard = memo(SimulationCard)

export function BoardSimulationLayer({ elements, records, viewport, interactive, readOnly, onRemove }: Props) {
  const cards = useMemo(() => elements.filter(isSimulationCard), [elements])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  useEffect(() => { if (focusedId && !cards.some((c) => c.id === focusedId)) setFocusedId(null) }, [cards, focusedId])
  if (!cards.length) return null
  return (
    <div data-sim-layer style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 2 }}>
      {cards.map((el) => (
        <MemoCard key={el.id} el={el} record={resolveSimulation(el, records)} viewport={viewport} interactive={interactive} readOnly={readOnly} onRemove={onRemove}
          focused={focusedId === el.id} onFocusToggle={setFocusedId} />
      ))}
    </div>
  )
}

export { simulationRefId }

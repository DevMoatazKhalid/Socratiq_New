import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Button } from "@/components/ui/Button"
import { DueDate } from "@/components/socratiq/DueDate"
import { QueryState } from "@/components/ui/States"
import { sendCoachStream, type CoachVisual, useCoachHistory, useStartAttempt, useStudentAssignment, useStudentCourse, useWhiteboard } from "@/lib/queries"
import { useWhiteboardRealtimeSync } from "@/lib/realtime"
import { BoardSurface, type BoardApi } from "@/components/smartboard/BoardSurface"
import type { BoardIntent } from "@/lib/boardAsk"
import { fromServer } from "@/lib/whiteboard"
import { useVoice, voiceSupport, type VoiceLang } from "@/lib/voice"
import { matchBoardCommand } from "@/lib/voiceCommands"
import { ApiError } from "@/lib/api"
import type { ChatMessage } from "@/types"
import { cn } from "@/lib/utils"
import { PersonaSelector } from "@/components/socratiq/PersonaSelector"
import { ResizableSplit } from "@/components/socratiq/ResizableSplit"
import { useMediaQuery } from "@/lib/useMediaQuery"
import { RichText } from "@/components/ui/RichText"
import { RunnableCodeBlock } from "@/components/socratiq/RunnableCodeBlock"
import { SaveToNotesButton } from "@/components/notes/SaveToNotesButton"
import { Maximize2, MessageSquare, Mic, Minimize2, PenLine, Send, Square, Volume2, VolumeX } from "lucide-react"

type VisualState = { kind: "diagram" | "simulation"; state: "pending" | "placed" | "failed" }
type Local = ChatMessage & { sources?: { documentTitle?: string; pageNumber?: number }[]; boardCount?: number; visual?: VisualState }

export default function AiCoach() {
  const { courseId = "", assignmentId = "" } = useParams()
  const course = useStudentCourse(courseId)
  const assignmentQ = useStudentAssignment(assignmentId)
  const history = useCoachHistory(assignmentId)
  const startAttempt = useStartAttempt()

  const [messages, setMessages] = useState<Local[]>([])
  const [draft, setDraft] = useState("")
  const [thinking, setThinking] = useState<string | null>(null)        // the real pipeline step the server last reported
  const [error, setError] = useState<string | null>(null)
  const [failedText, setFailedText] = useState<string | null>(null)       // last message that did not get a reply: offered for retry
  const [lang, setLang] = useState<VoiceLang>("en-US")
  const [readAloud, setReadAloud] = useState(false)
  const support = voiceSupport()
  const busy = useRef(false)                                              // blocks double submits (Enter twice, mic + button)
  const abort = useRef<AbortController | null>(null)
  const spoken = useRef(false)                                            // this turn was started by voice: answer aloud
  const scrollRef = useRef<HTMLDivElement>(null)

  // Two modes over the same Coach: Chat and Whiteboard. The board stays mounted (hidden in Chat mode) so its state and undo history persist.
  // On a wide screen (>= 1024px) both are visible side by side in one workspace (the student reads the explanation while looking at the board);
  // below that the original Chat / Whiteboard tabs apply. Either way the same session, transcript and board state: nothing is remounted.
  const split = useMediaQuery("(min-width: 1024px)")
  const [collapsed, setCollapsed] = useState<"left" | "right" | null>(null)       // split view only: hide the conversation or the board
  const [mode, setMode] = useState<"chat" | "board">("chat")
  const boardVisible = split ? collapsed !== "right" : mode === "board"
  const boardVisibleRef = useRef(boardVisible)
  boardVisibleRef.current = boardVisible
  const dense = split || mode === "board"                                           // compact chrome whenever the board is on screen
  const showBoard = () => { if (split) setCollapsed((c) => (c === "right" ? null : c)); else setMode("board") }
  const [streaming, setStreaming] = useState(false)                               // approved reply text is arriving
  const turnKey = useRef<{ key: string; text: string } | null>(null)             // idempotency key of the message being (re)tried, valid for THAT text only
  const wbQuery = useWhiteboard(assignmentId)
  useWhiteboardRealtimeSync(assignmentId)
  const boardApi = useRef<BoardApi | null>(null)
  // A visual the Coach decided on. In Whiteboard view it is drawn at once; in Chat view it waits for the board to be open (a hidden board has no
  // viewport to place it in), and the message says so. The server's grant is what permits the drawing: this page only carries it.
  const [pendingVisual, setPendingVisual] = useState<{ v: CoachVisual; msgId: string } | null>(null)
  const savedBoard = wbQuery.data ? fromServer(wbQuery.data) : null
  const loaded = useRef(false)
  const started = useRef(false)

  const closed = assignmentQ.data?.status === "submitted" || assignmentQ.data?.status === "verified"

  // the transcript is stored server-side; reloading the page restores it
  useEffect(() => {
    if (history.data && !loaded.current) {
      loaded.current = true
      setMessages(history.data)
    }
  }, [history.data])

  // The Coach works on an open attempt. Opening the chat starts one if needed (idempotent on the server).
  useEffect(() => {
    if (assignmentQ.data && !closed && !started.current) {
      started.current = true
      startAttempt.mutate(assignmentId)
    }
  }, [assignmentQ.data, closed, assignmentId, startAttempt])

  // Follow new messages only while the student is already at (or near) the bottom. Someone reading older messages is never yanked down, and sending a
  // message always returns them to the latest. While a reply streams we jump instantly (a smooth animation restarted on every token looks like jitter).
  const stick = useRef(true)
  const onChatScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stick.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? "auto" : "smooth" })
  }, [messages, thinking, streaming])

  async function placeVisual(v: CoachVisual, msgId: string) {
    const ok = (await boardApi.current?.runCoachVisual?.(v)) ?? false
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, visual: { kind: v.kind, state: ok ? "placed" : "failed" } } : x)))
  }
  useEffect(() => {
    if (!boardVisible || !pendingVisual) return
    const { v, msgId } = pendingVisual
    setPendingVisual(null)
    void placeVisual(v, msgId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardVisible, pendingVisual])

  async function handleSend(override?: string, boardIntent?: BoardIntent) {
    const text = (override ?? draft).trim()
    if (!text || busy.current || closed) return
    busy.current = true
    stick.current = true                                             // the student just spoke: show their message and the coming reply
    setError(null)
    setFailedText(null)
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "student", content: text }])
    setDraft("")
    setThinking("Starting…")
    await boardApi.current?.flush()                      // the Coach reads the board on the server: make sure it has the latest edits
    const ctl = new AbortController()
    abort.current = ctl
    const key = turnKey.current && turnKey.current.text === text ? turnKey.current.key : crypto.randomUUID()   // same message retried -> same key: a stored turn is returned, never duplicated
    turnKey.current = { key, text }
    const streamId = `streaming-${key}`
    let got = 0                                           // approved segments received: from the first one on, the server has stored the turn
    try {
      const reqMode = split ? (boardIntent ? "board" : "chat") : mode
      const r = await sendCoachStream({ assignmentId, message: text, mode: reqMode, selectedId: boardApi.current?.selectedId(), boardIntent, visuals: !!boardApi.current?.runCoachVisual, clientTurnId: key }, setThinking, ctl.signal, (delta) => {
        got++
        setStreaming(true)
        setMessages((m) => m.some((x) => x.id === streamId) ? m.map((x) => (x.id === streamId ? { ...x, content: x.content + delta } : x)) : [...m, { id: streamId, role: "coach", content: delta }])
      })
      turnKey.current = null
      if (r.board) boardApi.current?.applyServer(r.board)          // the server applied (and validated) what the Coach wrote
      setMessages((m) => [...m.filter((x) => x.id !== streamId), { ...r.message, sources: r.sources, boardCount: r.board?.report.applied.length || undefined, visual: r.visual ? { kind: r.visual.kind, state: "pending" } : undefined }])
      if (r.visual) {
        if (boardVisibleRef.current) void placeVisual(r.visual, r.message.id)
        else setPendingVisual({ v: r.visual, msgId: r.message.id })
      }
      if (spoken.current || readAloud) voice.speak(r.message.content)
      else voice.settle()
    } catch (e) {
      voice.settle()
      if (got > 0) {
        // The turn IS stored (text had started arriving): never show it as unsent and never ask to resend it. Show what the server holds.
        turnKey.current = null
        const fresh = await history.refetch?.()
        if (fresh?.data) setMessages(fresh.data)
        else setMessages((m) => m.filter((x) => x.id !== streamId))
        if (!ctl.signal.aborted) setError("The connection dropped while the reply was arriving. Your message and the reply were saved.")
        return
      }
      setMessages((m) => m.slice(0, -1))                 // the server did not record this turn, so don't show it as sent
      if (ctl.signal.aborted) {
        setDraft(text)                                   // cancelled by the student: put their words back, no error
      } else {
        const msg =
          e instanceof ApiError && e.code === "rate_limited" ? "You're sending messages quickly. Wait a moment, then send again."
          : e instanceof ApiError && e.code === "turn_in_progress" ? "SocratiQ is still answering your previous message. Give it a moment."
          : e instanceof ApiError && e.code === "ai_unavailable" ? "SocratiQ AI is unavailable right now. Your message wasn't saved."
          : e instanceof ApiError ? e.message
          : "Your message couldn't be sent."
        setError(msg)
        setFailedText(text)
        setDraft(text)
      }
    } finally {
      spoken.current = false
      abort.current = null
      busy.current = false
      setStreaming(false)
      setThinking(null)
    }
  }

  const voice = useVoice({
    lang,
    onTranscript: (t) => {
      spoken.current = true
      // In Whiteboard mode a spoken "explain this" / "is this correct?" is the same request as the matching board button. In Chat mode it stays an
      // ordinary message ("this" is ambiguous there). Clear / erase / organize are never shortcut by voice (see lib/voiceCommands).
      void handleSend(t, boardVisible ? (matchBoardCommand(t) ?? undefined) : undefined)
    },
  })
  useEffect(() => () => abort.current?.abort(), [])        // leaving the page cancels an in-flight turn (the server saves nothing)

  const listening = voice.state === "listening"
  const lastCoach = [...messages].reverse().find((m) => m.role === "coach")

  const header = (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--color-border)]", dense ? "px-4 py-2" : "px-5 py-3")}>
      <div className="min-w-0 flex-1 basis-48">
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="shrink-0 text-xs font-semibold text-[var(--color-teal-dark)]">Learning coach</p>
            <span className="shrink-0 text-xs text-[var(--color-ink-faint)]" aria-hidden="true">•</span>
            <h1 className="min-w-0 truncate text-sm font-semibold text-[var(--color-ink)] sm:text-base" title={assignmentQ.data?.topic || assignmentQ.data?.title}>{assignmentQ.data?.topic || assignmentQ.data?.title}</h1>
          </div>
          <div className={cn(dense ? "mt-0.5" : "mt-1.5")}>
            <DueDate dueDate={assignmentQ.data?.dueDate} done={closed} />
          </div>
        </div>
      </div>
      <PersonaSelector assignmentId={assignmentId} disabled={!!thinking} compact={dense} />
      {split ? (
        <div role="group" aria-label="Workspace panels" className="inline-flex shrink-0 gap-1">
          {([["left", "Conversation", MessageSquare], ["right", "Board", PenLine]] as const).map(([side, label, Icon]) => {
            const hidden = collapsed === side
            const other = side === "left" ? "right" : "left"
            return (
              <button
                key={side} type="button" aria-pressed={!hidden} aria-label={hidden ? `Show ${label}` : collapsed === other ? `Show both panels` : `Expand ${label}`}
                title={hidden ? `Show ${label}` : collapsed === other ? "Show both panels" : `Expand ${label} (hide the other panel)`}
                onClick={() => { voice.cancelListening(); voice.stopSpeaking(); setCollapsed(hidden || collapsed === other ? null : other) }}
                className="flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--color-control-border)] bg-white px-3 text-sm font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-muted)] aria-pressed:text-[var(--color-teal-dark)]"
              >
                <Icon className="h-4 w-4" aria-hidden="true" />{label}
                {collapsed === other ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> : !hidden ? <Maximize2 className="h-3.5 w-3.5 opacity-60" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      ) : (
        <div role="tablist" aria-label="Coach mode" className="inline-flex shrink-0 rounded-full bg-[var(--color-surface-muted)] p-0.5">
          {([["chat", "Chat", MessageSquare], ["board", "Whiteboard", PenLine]] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              type="button"
              id={`coach-tab-${id}`}
              aria-controls={`coach-panel-${id}`}
              aria-selected={mode === id}
              tabIndex={mode === id ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return
                e.preventDefault()
                const next = id === "chat" ? "board" : "chat"
                const target = e.key === "Home" ? "chat" : e.key === "End" ? "board" : next
                voice.cancelListening()
                voice.stopSpeaking()
                setMode(target)
                document.getElementById(`coach-tab-${target}`)?.focus()
              }}
              onClick={() => {
                if (mode !== id) {
                  voice.cancelListening()
                  voice.stopSpeaking()
                  setMode(id)
                }
              }}
              className={cn("flex min-h-9 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors", mode === id ? "bg-white text-[var(--color-teal-dark)] shadow-sm" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]")}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  const boardLoading = boardVisible && !savedBoard && (
    <div className="flex flex-1 items-center justify-center px-5 text-sm text-[var(--color-ink-muted)]">
      {wbQuery.isError ? <p role="alert" className="text-[var(--color-danger-ink)]">The whiteboard couldn't load. Reload the page to try again.</p> : <p role="status">Loading your whiteboard…</p>}
    </div>
  )
  const boardPanel = savedBoard && (
    <div id="coach-panel-board" {...(split ? {} : { role: "tabpanel", "aria-labelledby": "coach-tab-board" })} className={cn("min-h-0 flex-1 h-full", !split && mode !== "board" && "hidden")}>
      <BoardSurface ref={boardApi} assignmentId={assignmentId} courseId={courseId} initial={savedBoard} readOnly={closed} busy={!!thinking} onAsk={(intent, message) => void handleSend(message, intent)} />
    </div>
  )
  const chatScroll = (
    <div ref={scrollRef} onScroll={onChatScroll} id="coach-panel-chat" {...(split ? {} : { role: "tabpanel", "aria-labelledby": "coach-tab-chat" })} tabIndex={0} aria-live="polite" aria-relevant="additions" className={cn("thin-scroll flex-1 space-y-3 overflow-y-auto px-5 py-5", !split && mode === "board" && "hidden")}>
      {messages.length === 0 && !history.isPending && (
        <p className="text-center text-sm text-[var(--color-ink-muted)]">Tell SocratiQ where you're stuck, or paste what you've tried so far.</p>
      )}
      {messages.map((m) => (
        <Bubble key={m.id} message={m} onViewBoard={showBoard} topic={assignmentQ.data?.topic || assignmentQ.data?.title} />
      ))}
      {thinking && !streaming && (
        <div className="flex justify-start">
          <div className="flex items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-muted)] px-4 py-2.5 text-sm text-[var(--color-ink-muted)]">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-ink-faint)]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-ink-faint)] [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-ink-faint)] [animation-delay:300ms]" />
            </span>
            {thinking}
          </div>
        </div>
      )}
    </div>
  )
  const boardStrip = !split && mode === "board" && (thinking || lastCoach) && (
    <div className="flex items-start justify-between gap-3 border-t border-[var(--color-border)] bg-white px-4 py-2.5 text-sm" aria-live="polite">
      <p className={cn("line-clamp-3 min-w-0 whitespace-pre-wrap", thinking ? "text-[var(--color-ink-muted)]" : "text-[var(--color-ink)]")}>
        <span className="mr-1.5 font-semibold text-[var(--color-teal-dark)]">SocratiQ</span>{thinking ?? lastCoach?.content}
      </p>
      {!thinking && lastCoach && <Button type="button" size="sm" variant="secondary" className="shrink-0" onClick={() => setMode("chat")}>Open chat</Button>}
    </div>
  )
  const statusBars = (
    <div className="shrink-0">
      {(error || voice.error) && (
        <div role="alert" className="flex items-center justify-between gap-3 border-t border-[var(--color-danger-light)] bg-[var(--color-danger-light)]/40 px-5 py-2 text-sm text-[var(--color-danger-ink)]">
          <span>{error ?? voice.error}</span>
          {error && failedText && (
            <Button type="button" size="sm" variant="secondary" onClick={() => void handleSend(failedText)}>Retry</Button>
          )}
        </div>
      )}
      {(support.listen || support.speak) && (listening || voice.state === "thinking" || voice.state === "speaking") && (
        <div role="status" aria-live="polite" className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] px-5 py-2 text-sm text-[var(--color-ink-soft)]">
          <span>
            {listening ? `Listening… ${voice.interim}` : voice.state === "thinking" ? "Thinking…" : "Speaking…"}
          </span>
          {voice.state === "speaking" && <Button type="button" size="sm" variant="secondary" onClick={voice.stopSpeaking}>Stop speaking</Button>}
          {listening && <Button type="button" size="sm" variant="secondary" onClick={voice.cancelListening}>Cancel</Button>}
        </div>
      )}
      {closed && <p className="border-t border-[var(--color-border)] px-5 py-2 text-sm text-[var(--color-ink-soft)]">You've submitted this assignment, so the coaching chat is now read-only.</p>}
    </div>
  )
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The composer grows with what is typed (up to ~6 lines, then scrolls inside itself) so it never pushes the conversation off-screen or hides text.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, 144)}px`
  }, [draft, split, mode])
  const ctl = dense && !split            // the compact control sizes belong to the old full-screen board mode; the split view keeps the roomy composer
  const composer = (
    <form
      className={cn("flex shrink-0 flex-wrap items-end gap-2 border-t border-[var(--color-border)] pb-[max(0.75rem,env(safe-area-inset-bottom))]", ctl ? "p-1.5 px-3 bg-white" : "p-3")}
      onSubmit={(e) => {
        e.preventDefault()
        void handleSend()
      }}
    >
      <textarea
        ref={inputRef}
        rows={1}
        dir="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter adds a line. Never while an IME (Arabic, CJK) is still composing a word.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit() }
        }}
        disabled={closed}
        maxLength={4000}
        placeholder={!split && mode === "board" ? "Ask SocratiQ about the board, or tell it what to write…" : split ? "Ask SocratiQ, or about what's on the board…" : "Start your chat here…"}
        className={cn(
          "min-w-0 resize-none rounded-[1.25rem] border max-sm:basis-full sm:flex-1 py-2 leading-5 border-[var(--color-control-border)] bg-white px-3.5 text-sm placeholder:text-[var(--color-ink-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)] disabled:opacity-60",
          ctl ? "min-h-9 text-xs sm:text-sm" : "min-h-11"
        )}
        aria-label="Message SocratiQ AI"
      />
      {support.listen && (
        <>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as VoiceLang)}
            disabled={listening}
            aria-label="Voice language"
            className={cn("rounded-full border border-[var(--color-control-border)] bg-white px-2 text-xs", ctl ? "h-9" : "h-11")}
          >
            <option value="en-US">EN</option>
            <option value="ar-EG">AR</option>
          </select>
          <Button
            type="button"
            size="md"
            variant="secondary"
            className={cn("rounded-full p-0 shrink-0", ctl ? "h-9 w-9" : "h-11 w-11")}
            aria-label={listening ? "Stop recording and send" : "Speak your message"}
            aria-pressed={listening}
            disabled={closed || (!listening && !!thinking)}
            onClick={() => (listening ? voice.stopListening() : voice.start())}
          >
            {listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
        </>
      )}
      {support.speak && (
        <Button
          type="button"
          size="md"
          variant="secondary"
          className={cn("rounded-full p-0 shrink-0", ctl ? "h-9 w-9" : "h-11 w-11")}
          aria-label={readAloud ? "Turn off reading replies aloud" : "Read replies aloud"}
          aria-pressed={readAloud}
          onClick={() => { if (readAloud) voice.stopSpeaking(); setReadAloud((v) => !v) }}
        >
          {readAloud ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </Button>
      )}
      {thinking ? (
        <Button type="button" size="md" variant="secondary" className={cn("rounded-full p-0 shrink-0 max-sm:ml-auto", ctl ? "h-9 w-9" : "h-11 w-11")} aria-label="Cancel and edit message" onClick={() => abort.current?.abort()}>
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button type="submit" size="md" className={cn("rounded-full p-0 shrink-0 max-sm:ml-auto", ctl ? "h-9 w-9" : "h-11 w-11")} aria-label="Send message" disabled={closed}>
          <Send className="h-4 w-4" />
        </Button>
      )}
    </form>
  )

  return (
    <AppShell
      role="student"
      fitViewport
      mainClassName={dense ? "p-0" : "p-3 sm:p-4 lg:p-8"}
      crumbs={[
        { label: "Courses", to: "/student/courses" },
        { label: course.data?.course.name ?? "Course", to: `/student/courses/${courseId}` },
        { label: assignmentQ.data?.title ?? "Assignment", to: `/student/courses/${courseId}/assignments/${assignmentId}` },
        { label: "SocratiQ AI" },
      ]}
    >
      <QueryState query={assignmentQ} what="Assignment">
        {() => (
          <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-white", dense ? "w-full rounded-none border-none" : "mx-auto w-full max-w-3xl rounded-[var(--radius-lg)] border border-[var(--color-border)]")}>
            {header}
            {split ? (
              <ResizableSplit
                collapsed={collapsed}
                left={<>{chatScroll}{statusBars}{composer}</>}
                right={<>{boardLoading}{boardPanel}</>}
              />
            ) : (
              <>
                {boardLoading}
                {boardPanel}
                {chatScroll}
                {boardStrip}
                {statusBars}
                {composer}
              </>
            )}
          </div>
        )}
      </QueryState>
    </AppShell>
  )
}

function Bubble({ message, onViewBoard, topic }: { message: Local; onViewBoard: () => void; topic?: string }) {
  const isStudent = message.role === "student"
  const cites = (message.sources ?? []).filter((s) => s.documentTitle)
  const final = !isStudent && !message.id.startsWith("streaming-")          // a reply still arriving is not runnable or saveable yet
  return (
    <div className={cn("flex", isStudent ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0 max-w-[88%] rounded-[var(--radius-lg)] px-4 py-2.5 text-sm sm:max-w-[75%]",
          isStudent ? "bg-[var(--color-teal-light)] text-[var(--color-ink)]" : "bg-[var(--color-surface-muted)] text-[var(--color-ink)]"
        )}
      >
        <RichText
          text={message.content}
          detectCode={isStudent}
          renderCodeBlock={final ? (code, lang, i) => <RunnableCodeBlock code={code} lang={lang} blockKey={`${message.id}:${i}`} /> : undefined}
        />
        {!isStudent && message.boardCount ? (
          <button type="button" onClick={onViewBoard} className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-teal-dark)]/30 bg-white px-2.5 py-1 text-xs font-medium text-[var(--color-teal-dark)] hover:bg-[var(--color-teal-light)]">
            <PenLine className="h-3.5 w-3.5" aria-hidden="true" />Wrote {message.boardCount} {message.boardCount === 1 ? "item" : "items"} on the board · View board
          </button>
        ) : null}
        {!isStudent && message.visual ? (
          message.visual.state === "failed" ? (
            <p className="mt-2 text-xs text-[var(--color-ink-muted)]">The {message.visual.kind} couldn't be drawn this time. Let's keep going here.</p>
          ) : (
            <button type="button" onClick={onViewBoard} className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-teal-dark)]/30 bg-white px-2.5 py-1 text-xs font-medium text-[var(--color-teal-dark)] hover:bg-[var(--color-teal-light)]">
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />{message.visual.state === "placed" ? `SocratiQ added a ${message.visual.kind} to your board` : `SocratiQ prepared a ${message.visual.kind} for your board`} · {message.visual.state === "placed" ? "View board" : "Open board"}
            </button>
          )
        ) : null}
        {cites.length > 0 && (
          <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
            From course material: {cites.map((s) => `${s.documentTitle}${s.pageNumber ? ` (p. ${s.pageNumber})` : ""}`).join(", ")}
          </p>
        )}
        {final && message.content.trim() && <SaveToNotesButton messageId={message.id} content={message.content} topic={topic} />}
      </div>
    </div>
  )
}

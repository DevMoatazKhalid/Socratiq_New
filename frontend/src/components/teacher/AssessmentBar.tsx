import { useState } from "react"
import { Bot, CheckCheck, Loader2, Settings2, Sparkles } from "lucide-react"
import { Dialog } from "@/components/ui/Dialog"
import { ApiError } from "@/lib/api"
import { formatNumber } from "@/lib/grades"
import { useGradingActions, type GradingOverview } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { ExportGradesButton } from "./ExportGradesButton"
import { GradingSetup } from "./GradingSetup"

const MODE_LABEL = { off: "AI grading off", review: "AI drafts · you release", auto_release: "AI drafts · confident ones auto-released" } as const

/**
 * The assignment's assessment controls above the grading workspace: how it is graded (rubric, AI mode), where the class stands (drafts
 * ready, needing review, in progress), and the bulk actions — draft everything with AI, release the drafts you trust, export to Excel.
 */
export function AssessmentBar({ assignmentId, assignmentTitle, courseId, courseLabel, overview }: {
  assignmentId: string
  assignmentTitle: string
  courseId: string
  courseLabel: string
  overview: GradingOverview
}) {
  const { run, release } = useGradingActions(assignmentId)
  const [setup, setSetup] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)
  const { settings, counts } = overview
  const aiOn = settings.aiGrading !== "off"
  const ungraded = counts.submitted - counts.graded
  const releasable = overview.students.filter((r) => !r.grade && r.evaluation?.status === "COMPLETED" && !r.evaluation.stale && !r.evaluation.needsReview).length

  const fail = (e: unknown) => setNote({ tone: "bad", text: e instanceof ApiError ? e.message : "That didn't work. Please try again." })

  function gradeAll() {
    setNote(null)
    run.mutate({}, {
      onSuccess: (r) => setNote({ tone: "ok", text: r.queued ? `SocratiQ is drafting ${r.queued} grade${r.queued === 1 ? "" : "s"}. They appear here as they finish.` :
        "Nothing new to draft: every ungraded submission already has an up-to-date draft." }),
      onError: fail,
    })
  }

  function releaseAll() {
    setConfirm(false)
    release.mutate({}, {
      onSuccess: (r) => {
        const held = r.skipped.needsReview + r.skipped.blocked
        setNote({ tone: "ok", text: `Released ${r.released} grade${r.released === 1 ? "" : "s"}.${held ? ` ${held} draft${held === 1 ? " needs" : "s need"} your review first — open ${held === 1 ? "it" : "them"} in the list.` : ""}` })
      },
      onError: fail,
    })
  }

  return (
    <section className="ds-card mt-5 px-5 py-4 sm:px-7" aria-label="Assessment">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-teal-light)] text-[var(--color-teal-dark)]"><Bot className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-[15px] font-bold">{MODE_LABEL[settings.aiGrading]}</p>
            <p className="text-[13px] text-[var(--color-ink-muted)]">
              {settings.rubric.length ? `Rubric · ${settings.rubric.length} criteria · ${formatNumber(settings.pointsPossible)} pts` : `No rubric · out of ${formatNumber(settings.pointsPossible)}`}
              {settings.rubricSource === "ai" && settings.rubric.length > 0 && <span className="ml-1.5 ds-pill ds-pill-or">Drafted by AI — review it</span>}
            </p>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]" aria-label="Grading status">
          {[["Graded", counts.graded, "ok"], ["Drafts ready", counts.draftsReady, "info"], ["Need review", counts.needsReview, "warn"], ["Drafting", counts.inProgress, "neu"], ["Failed", counts.failed, "bad"]]
            .filter(([, n, tone]) => (n as number) > 0 || tone === "ok")
            .map(([label, n, tone]) => (
              <div key={label as string} className="flex items-center gap-1.5">
                <span className={cn("ds-dot", tone === "ok" ? "bg-[var(--color-success)]" : tone === "info" ? "bg-[var(--color-teal-dark)]" : tone === "warn" ? "bg-[var(--color-warning)]" : tone === "bad" ? "bg-[var(--color-danger)]" : "bg-[var(--color-border-strong)]")} aria-hidden="true" />
                <dt className="text-[var(--color-ink-muted)]">{label}</dt><dd className="font-bold ds-num">{n as number}</dd>
              </div>
            ))}
          {counts.inProgress > 0 && <Loader2 className="h-4 w-4 animate-spin text-[var(--color-ink-muted)]" aria-label="Drafting" />}
        </dl>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <button type="button" className="ds-btn ds-btn-sm" onClick={() => setSetup(true)}><Settings2 className="h-3.5 w-3.5" aria-hidden="true" />Grading setup</button>
          {aiOn && ungraded > 0 && (
            <button type="button" className="ds-btn ds-btn-sm ds-btn-soft" onClick={gradeAll} disabled={run.isPending}>
              {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}Draft all with AI
            </button>
          )}
          {releasable > 0 && (
            <button type="button" className="ds-btn ds-btn-sm ds-btn-pri" onClick={() => setConfirm(true)} disabled={release.isPending}>
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />Release {releasable} draft{releasable === 1 ? "" : "s"}
            </button>
          )}
          <ExportGradesButton compact courseId={courseId} courseLabel={courseLabel} assignment={{ id: assignmentId, title: assignmentTitle }} />
        </div>
      </div>
      {note && <p role="status" className={cn("mt-3 rounded-[10px] px-3 py-2 text-[13px]", note.tone === "ok" ? "bg-[var(--color-success-light)] text-[var(--color-success-ink)]" : "bg-[var(--color-danger-light)] text-[var(--color-danger-ink)]")}>{note.text}</p>}

      <GradingSetup assignmentId={assignmentId} settings={settings} open={setup} onClose={() => setSetup(false)} onSaved={(text) => setNote({ tone: "ok", text })} />
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Release ${releasable} AI draft${releasable === 1 ? "" : "s"}?`}
        description="Students will see these grades and their feedback right away."
        footer={<><button type="button" className="ds-btn" onClick={() => setConfirm(false)}>Cancel</button>
          <button type="button" className="ds-btn ds-btn-pri" onClick={releaseAll} disabled={release.isPending}>Release grades</button></>}>
        <ul className="space-y-2 text-sm">
          <li>• Only up-to-date drafts with no concerns are released, exactly as drafted. You can still change any of them afterwards.</li>
          {counts.needsReview > 0 && <li>• {counts.needsReview} draft{counts.needsReview === 1 ? "" : "s"} flagged for review stay{counts.needsReview === 1 ? "s" : ""} unreleased until you open {counts.needsReview === 1 ? "it" : "them"}.</li>}
          <li>• Grades you already gave are never changed.</li>
        </ul>
      </Dialog>
    </section>
  )
}

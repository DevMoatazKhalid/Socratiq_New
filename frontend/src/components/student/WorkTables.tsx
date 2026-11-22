import { Link, useNavigate } from "react-router-dom"
import { GradeValue, Pill, Section, Steps } from "@/components/ds"
import { assignmentStatusLabel } from "@/lib/assignments"
import { duePill, shortDate, statusTone, type WorkRow } from "@/lib/studentWork"
import { cn } from "@/lib/utils"

function TitleCell({ r }: { r: WorkRow }) {
  return (
    <Link to={r.action.to.replace(/\/verify$|#grade$/, "")} className="block min-w-[140px] hover:underline">
      <b className="font-semibold text-[var(--color-ink)]">{r.a.title}</b>
      {r.a.topic && <span className="block text-xs text-[var(--color-ink-muted)]">{r.a.topic}</span>}
    </Link>
  )
}

/** "Upcoming assignments": still to do: start, coach, submit, verify. */
export function UpcomingTable({ rows, showCourse = true, title = "Upcoming assignments", sub = "Still to do: start, coach, submit, verify", empty }: {
  rows: WorkRow[]; showCourse?: boolean; title?: string; sub?: string; empty?: string
}) {
  const navigate = useNavigate()
  return (
    <Section title={title} count={rows.length} sub={sub} right="Sorted by what needs you first" flush>
      {rows.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">{empty ?? "Nothing to do right now. New assignments appear here when your instructor publishes them."}</p>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table min-w-[860px]">
            <thead>
              <tr>
                <th>Assignment</th>
                {showCourse && <th>Course</th>}
                <th>Status</th>
                <th>Progress · Attempt › Coach › Submit › Verify</th>
                <th>Due</th>
                <th><span className="sr-only">Next step</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pill = duePill(r)
                return (
                  <tr key={r.a.id}>
                    <td><TitleCell r={r} /></td>
                    {showCourse && <td>{r.course?.name ?? ""}</td>}
                    <td><Pill tone={statusTone[r.status]}>{assignmentStatusLabel[r.status]}</Pill></td>
                    <td><Steps current={r.step} done={r.done} /></td>
                    <td className="whitespace-nowrap">
                      <span className="ds-num">{r.a.dueDate ? shortDate(r.a.dueDate) : "No due date"}</span>
                      {pill && <Pill tone={pill.tone} className="ml-2">{pill.text}</Pill>}
                    </td>
                    <td className="text-right">
                      <button type="button" onClick={() => navigate(r.action.to)} className={cn("ds-btn ds-btn-sm !rounded-full", r.action.primary && "ds-btn-pri")}>
                        {r.action.label}<span className="sr-only">: {r.a.title}</span>
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function verificationPill(v: WorkRow["verification"], status?: WorkRow["status"]) {
  // without per-question counts (older server) the assignment status still says whether the work was verified
  if (!v && status === "verified") return <Pill tone="ok">Verified</Pill>
  if (!v || v.total === 0) return <Pill tone="neu">None yet</Pill>
  return <Pill tone={v.passed === v.total ? "ok" : "neu"}>{v.passed} of {v.total}</Pill>
}

/** "Finished & graded": reviewed by the instructor, with the verification result. Only rows that have a grade. */
export function GradedTable({ rows, showCourse = true }: { rows: WorkRow[]; showCourse?: boolean }) {
  const navigate = useNavigate()
  return (
    <Section title="Finished & graded" count={rows.length} countTone="ok" sub="Reviewed by your instructor, with your verification result" right="Newest first" flush>
      {rows.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">No graded work yet. Grades and feedback appear here once your instructor reviews a submission.</p>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table min-w-[860px]">
            <thead>
              <tr>
                <th>Assignment</th>
                {showCourse && <th>Course</th>}
                <th>Graded on</th>
                <th>Grade</th>
                <th>Verification</th>
                <th>Feedback</th>
                <th><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.a.id}>
                  <td><TitleCell r={r} /></td>
                  {showCourse && <td>{r.course?.name ?? ""}</td>}
                  <td className="whitespace-nowrap ds-num">{shortDate(r.grade?.gradedAt)}</td>
                  <td><GradeValue pct={r.grade?.percentage} /></td>
                  <td>{verificationPill(r.verification, r.status)}</td>
                  <td className="max-w-[320px] text-[var(--color-ink-muted)]"><span className="line-clamp-2">{r.grade?.feedback || "No written feedback."}</span></td>
                  <td className="text-right">
                    <button type="button" onClick={() => navigate(r.action.to)} className="ds-btn ds-btn-sm !rounded-full">{r.grade ? "View feedback" : "Open"}<span className="sr-only">: {r.a.title}</span></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

export { verificationPill }

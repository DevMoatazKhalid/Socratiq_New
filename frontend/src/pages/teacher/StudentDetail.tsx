import { useParams } from "react-router-dom"
import { ArrowRight, Download } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { Avatar } from "@/components/ui/Avatar"
import { Badge } from "@/components/ui/Badge"
import { ButtonLink } from "@/components/ui/Button"
import { PageIntro } from "@/components/ui/PageIntro"
import { QueryState } from "@/components/ui/States"
import { MasteryBadge } from "@/components/socratiq/MasteryBadge"
import { RiskPanel } from "@/components/socratiq/RiskPanel"
import { StudentSkeleton } from "@/components/socratiq/Skeletons"
import { AiUsagePanel, AssignmentProgress, ConceptPanel, LearningTimeline, VerificationPanel, reviewPath } from "@/components/socratiq/StudentSections"
import { useCourses, useTeacherInsights, useTeacherStudent } from "@/lib/queries"
import { Kpi } from "@/components/ds"
import type { Course, StudentDetailInfo } from "@/types"
import type { TeacherInsights } from "@/lib/queries"
import { relativeTime } from "@/lib/time"

const SECTIONS = [
  ["review", "Review overview"], ["timeline", "Learning process"], ["coach", "Coach activity"],
  ["concepts", "Concepts"], ["verification", "Verification"], ["progress", "Assignments"],
] as const

/** Investigation flow: who -> is anything flagged and why -> what happened -> Coach use -> concepts -> verification -> progress. */
export default function StudentDetail() {
  const { studentId = "" } = useParams()
  const q = useTeacherStudent(studentId)
  const allCourses = useCourses("teacher").data ?? []
  const insights = useTeacherInsights(q.data?.courseIds[0])

  return (
    <AppShell role="teacher" crumbs={[{ label: "Students", to: "/teacher/students" }, { label: q.data?.name ?? "Student" }]}>
      <QueryState query={q} what="Student" skeleton={<StudentSkeleton />}>
        {(student) => {
          const courses = student.courseIds.map((id) => allCourses.find((c) => c.id === id)).filter((c): c is Course => c !== undefined)
          const titles = Object.fromEntries(student.assignments.map((a) => [a.assignmentId, a.title]))
          const courseOf = Object.fromEntries(student.assignments.map((a) => [a.assignmentId, a.courseId]))
          const submissionLink = (assignmentId: string) => (courseOf[assignmentId] ? reviewPath(courseOf[assignmentId], assignmentId, student.id) : null)
          const latest = student.assignments.find((a) => a.submitted)
          const submitted = student.assignments.filter((a) => a.submitted).length
          const per = insights.data?.students.find((x) => x.id === student.id)
          return (
            <div className="space-y-5">
              <PageIntro
                leading={<Avatar name={student.name} className="h-14 w-14 text-base" />}
                eyebrow="Student"
                title={student.name}
                subtitle={<>{student.email} · Last activity {relativeTime(student.lastActivityAt)}</>}
                meta={
                  <>
                    {courses.map((c) => <Badge key={c.id} tone="slate">{c.name}</Badge>)}
                    <Badge tone="neutral">Submitted {submitted} of {student.assignments.length}</Badge>
                    <MasteryBadge level={student.mastery} />
                  </>
                }
                actions={
                  <>
                    {latest && <ButtonLink to={reviewPath(latest.courseId, latest.assignmentId, student.id)} size="sm" variant="outline" className="gap-1.5">Latest submission <ArrowRight className="h-4 w-4" aria-hidden="true" /></ButtonLink>}
                    <button type="button" className="ds-btn ds-btn-sm gap-1.5" onClick={() => downloadStudentInfo(student, courses, per)}><Download className="h-4 w-4" aria-hidden="true" />Download student info</button>
                    {student.courseIds[0] && <ButtonLink to={`/teacher/courses/${student.courseIds[0]}`} size="sm" variant="ghost">Course page</ButtonLink>}
                  </>
                }
              />

              <nav aria-label="On this page" className="ds-tabs">
                {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className="ds-tab">{label}</a>)}
              </nav>

              {/* Three lenses, shown side by side and never combined into one score (approved design). */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Kpi label="Academic performance" value={per?.averageGrade == null ? "—" : `${Math.round(per.averageGrade)}%`}
                  hint={per ? `Average of ${per.graded} graded assignment${per.graded === 1 ? "" : "s"}${per.awaiting ? ` · ${per.awaiting} not graded` : ""}` : "Graded work only"} />
                <Kpi label="Learning understanding" value={per?.verificationRate == null ? "—" : `${per.verificationRate}%`}
                  hint={`Verification success · ${student.verification.length} run${student.verification.length === 1 ? "" : "s"}`} />
                <Kpi label="Engagement" value={`${student.aiUsage.interactions} turns`} hint={`AI Coach usage · ${student.revisions} revision${student.revisions === 1 ? "" : "s"}`} />
              </div>
              <p className="-mt-2 text-xs text-[var(--color-ink-muted)]">Three lenses are shown separately and never combined into one score.</p>

              <RiskPanel risk={student.risk} assignmentTitles={titles} submissionLink={submissionLink} />

              <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-5">
                <div className="lg:col-span-3"><LearningTimeline entries={student.timeline} studentId={student.id} /></div>
                <div className="space-y-5 lg:col-span-2">
                  <AiUsagePanel usage={student.aiUsage} />
                  <ConceptPanel concepts={student.concepts} />
                </div>
              </div>

              <VerificationPanel runs={student.verification} studentId={student.id} />
              <AssignmentProgress items={student.assignments} studentId={student.id} />
            </div>
          )
        }}
      </QueryState>
    </AppShell>
  )
}

const csvCell = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }

/** The student's record as a spreadsheet: profile, the three lenses, every assignment, concept mastery. Only what this page already shows. */
function downloadStudentInfo(s: StudentDetailInfo, courses: Course[], per?: TeacherInsights["students"][number]) {
  const rows: unknown[][] = [
    ["Student", s.name], ["Email", s.email], ["Courses", courses.map((c) => `${c.name} (${c.code})`).join("; ")],
    ["Last activity", s.lastActivityAt ?? ""], ["Mastery", s.mastery ?? ""],
    ["Average grade %", per?.averageGrade == null ? "" : Math.round(per.averageGrade)], ["Graded", per?.graded ?? ""], ["Awaiting a grade", per?.awaiting ?? ""],
    ["Task submission %", s.taskSubmission], ["AI Coach use %", s.socraticAiUsage], ["Review signal rate %", s.observedSignalRate],
    ["Attempts", s.attempts], ["Revisions", s.revisions], ["Struggling topics", s.strugglingTopics.join("; ")],
    [],
    ["Assignment", "Due", "Submitted", "Verification", "Coach turns"],
    ...s.assignments.map((a) => [a.title, a.dueAt ?? "", a.submitted ? "Yes" : "No", a.verificationOutcome ?? "", a.coachTurns ?? ""]),
    [],
    ["Concept", "Level", "Mastery %", "Evidence"],
    ...(s.concepts ?? []).map((c) => [c.name, c.level ?? "", c.mastery == null ? "" : Math.round(c.mastery * 100), c.evidenceCount ?? ""]),
  ]
  const body = rows.map((r) => r.map(csvCell).join(",")).join("\r\n")
  const url = URL.createObjectURL(new Blob(["\ufeff" + body], { type: "text/csv;charset=utf-8" }))   // BOM: Excel opens Arabic names correctly
  const a = Object.assign(document.createElement("a"), { href: url, download: `${s.name.replace(/\s+/g, "-").toLowerCase() || "student"}-info.csv` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

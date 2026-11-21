import { AppShell } from "@/components/layout/AppShell"
import { PageTitle } from "@/components/ds"
import { JoinCourseCard } from "@/components/socratiq/CourseCard"
import { JoinCodeForm } from "@/components/student/JoinCodeForm"

/** Join a course: the same invite-code card as on "My courses", on its own page (sidebar link). */
export default function JoinCourse() {
  return (
    <AppShell role="student" crumbs={[{ label: "My courses", to: "/student/courses" }, { label: "Join a course" }]}>
      <PageTitle title="Join a course" subtitle="Enter the invite code your instructor shared to add their course to your list." />
      <div className="max-w-[420px]">
        <JoinCourseCard label="Invite code">
          <p className="text-[13px] text-[var(--color-ink-muted)]">Codes look like ALG-7K2P. Ask your instructor if you don't have one.</p>
          <JoinCodeForm className="mt-2" autoFocus />
        </JoinCourseCard>
      </div>
    </AppShell>
  )
}

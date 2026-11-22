import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Input } from "@/components/ui/Input"
import { Field } from "@/components/ui/Field"
import { PageTitle } from "@/components/ds"
import { COURSE_ICONS, CourseCard, courseColor } from "@/components/socratiq/CourseCard"
import { useAuth } from "@/lib/auth"
import { ApiError } from "@/lib/api"
import { useServerState } from "@/lib/capabilities"
import { useCreateCourse } from "@/lib/queries"
import { cn } from "@/lib/utils"
import type { Course, CourseIconName } from "@/types"

const colorOptions: { key: Course["color"]; label: string }[] = [
  { key: "clay", label: "red-orange" },
  { key: "plum", label: "orange" },
  { key: "slate", label: "olive" },
  { key: "teal", label: "sage" },
]

/** Create a course (approved design E-newcourse): name, code, description, course icon grid, card colour and a live preview. */
export default function CreateCourse() {
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [description, setDescription] = useState("")
  const [color, setColor] = useState<Course["color"]>("clay")
  const [icon, setIcon] = useState<CourseIconName>("code")
  const { me } = useAuth()
  const server = useServerState()
  const iconsSaved = server.status === "ok" && server.caps.features.courseIcons
  const [error, setError] = useState<string | null>(null)
  const create = useCreateCourse()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim() || !code.trim()) {
      setError("Give the course a name and a course code to continue.")
      return
    }
    try {
      const course = await create.mutateAsync({ code: code.trim(), title: name.trim(), description: description.trim(), color, icon })
      navigate(`/teacher/courses/${course.id}`)      // the new course page shows the invite code students join with
    } catch (err) {
      setError(err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : "The course couldn't be created. Try again.")
    }
  }

  const preview: Course = { id: "preview", code: code.trim() || "CODE", name: name.trim() || "Course name", description: description.trim() || "What will students cover?",
    teacher: me?.name ?? "", status: "Active", color, icon, materialCount: 0, assignmentCount: 0, studentCount: 0 }

  return (
    <AppShell role="teacher" crumbs={[{ label: "Courses", to: "/teacher/courses" }, { label: "New course" }]}>
      <PageTitle title="Create a course" subtitle="Set up a new virtual classroom. You'll get an invite code to share with students once it's created." />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,532px)_388px]">
        <form className="ds-card space-y-[18px] p-[26px]" onSubmit={handleSubmit} noValidate>
          <Field id="course-name" label="Course name">
            <Input id="course-name" placeholder="e.g. Intro to Algorithms" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} dir="auto" />
          </Field>
          <Field id="course-code" label="Course code">
            <Input id="course-code" placeholder="e.g. CS201" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" maxLength={30} />
          </Field>
          <Field id="course-description" label="Description">
            <textarea id="course-description" dir="auto" className="ds-input min-h-[80px] resize-y" placeholder="What will students cover?" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </Field>

          <div role="radiogroup" aria-labelledby="course-icon-label">
            <p id="course-icon-label" className="ds-label">Course icon</p>
            <div className="grid grid-cols-6 gap-2.5">
              {COURSE_ICONS.map(({ name: key, label, Icon }) => {
                const on = icon === key
                return (
                  <button key={key} type="button" role="radio" aria-checked={on} aria-label={label} title={label} onClick={() => setIcon(key)}
                    className={cn("flex aspect-square items-center justify-center rounded-[12px] border bg-white text-[var(--color-ink)] transition-colors",
                      on ? "border-[var(--color-plum)] bg-[#fff1dd] ring-2 ring-[var(--color-plum)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]")}>
                    <Icon className="h-[22px] w-[22px]" strokeWidth={1.7} aria-hidden="true" />
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
              Shown next to the course on your courses page and on the course itself.
              {server.status !== "unknown" && !iconsSaved && " The server can't store icons yet (migration 021), so a matching icon is chosen from the title for now."}
            </p>
          </div>

          <div role="radiogroup" aria-labelledby="course-color-label">
            <p id="course-color-label" className="ds-label">Card color</p>
            <div className="flex gap-2.5">
              {colorOptions.map((opt) => (
                <button key={opt.key} type="button" role="radio" onClick={() => setColor(opt.key)} aria-label={`${opt.label} card`} aria-checked={color === opt.key}
                  className={cn("h-10 w-10 rounded-full", color === opt.key && "ring-2 ring-[var(--color-ink)] ring-offset-2")} style={{ background: courseColor[opt.key] }} />
              ))}
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-[var(--color-danger-ink)]">{error}</p>}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button type="button" className="ds-btn" onClick={() => navigate(-1)}>Cancel</button>
            <button type="submit" className="ds-btn ds-btn-pri" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create course"}</button>
          </div>
        </form>
        <aside aria-label="Preview" className="lg:pt-0">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-ink-muted)]">Preview</h2>
          <CourseCard course={preview} to="#" footer="0 students" className="pointer-events-none" />
        </aside>
      </div>
    </AppShell>
  )
}

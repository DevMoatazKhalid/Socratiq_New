import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { Input } from "@/components/ui/Input"
import { Field } from "@/components/ui/Field"
import { PageTitle } from "@/components/ds"
import { CourseCard, courseColor } from "@/components/socratiq/CourseCard"
import { useAuth } from "@/lib/auth"
import { ApiError } from "@/lib/api"
import { useCreateCourse } from "@/lib/queries"
import type { Course } from "@/types"

const colorOptions: { key: Course["color"]; label: string }[] = [
  { key: "clay", label: "red-orange" },
  { key: "plum", label: "orange" },
  { key: "slate", label: "olive" },
  { key: "teal", label: "sage" },
]

export default function CreateCourse() {
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [description, setDescription] = useState("")
  const [color, setColor] = useState<Course["color"]>("clay")
  const { me } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const create = useCreateCourse()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name || !code) {
      setError("Give the course a name and a course code to continue.")
      return
    }
    try {
      const course = await create.mutateAsync({ code: code.trim(), title: name.trim(), description: description.trim(), color })
      navigate(`/teacher/courses/${course.id}`)      // the new course page shows the invite code students join with
    } catch (err) {
      setError(err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : "The course couldn't be created. Try again.")
    }
  }

  const preview: Course = { id: "preview", code: code.trim() || "CODE", name: name.trim() || "Course name", description: description.trim() || "What will students cover?",
    teacher: me?.name.split(" ").filter((w) => !w.endsWith(".")).join(" ") ?? "", status: "Active", color, materialCount: 0, assignmentCount: 0, studentCount: 0 }

  return (
    <AppShell role="teacher" crumbs={[{ label: "My courses", to: "/teacher/courses" }, { label: "New course" }]}>
      <PageTitle title="Create a course" subtitle="Set up a new virtual classroom. You'll get an invite code to share with students once it's created." />
      <div className="grid max-w-[1040px] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form className="ds-card space-y-5 p-6" onSubmit={handleSubmit} noValidate>
          <Field id="course-name" label="Course name">
            <Input id="course-name" placeholder="e.g. Intro to Algorithms" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={200} />
          </Field>
          <Field id="course-code" label="Course code">
            <Input id="course-code" placeholder="e.g. CS201" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" maxLength={40} />
          </Field>
          <Field id="course-description" label="Description">
            <textarea id="course-description" className="ds-input min-h-[96px] resize-y" placeholder="What will students cover?" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div role="group" aria-labelledby="course-color-label">
            <p id="course-color-label" className="ds-label">Card color</p>
            <div className="flex gap-2.5">
              {colorOptions.map((opt) => (
                <button key={opt.key} type="button" onClick={() => setColor(opt.key)} aria-label={`Use ${opt.label} color`} aria-pressed={color === opt.key}
                  className={`h-9 w-9 rounded-full ${color === opt.key ? "ring-2 ring-[var(--color-ink)] ring-offset-2" : ""}`} style={{ background: courseColor[opt.key] }} />
              ))}
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-[var(--color-danger-ink)]">{error}</p>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" className="ds-btn" onClick={() => navigate(-1)}>Cancel</button>
            <button type="submit" className="ds-btn ds-btn-pri" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create course"}</button>
          </div>
        </form>
        <aside aria-label="Preview">
          <h2 className="mb-2 text-sm font-bold">Preview</h2>
          <CourseCard course={preview} to="#" footer="0 students" className="pointer-events-none" />
        </aside>
      </div>
    </AppShell>
  )
}

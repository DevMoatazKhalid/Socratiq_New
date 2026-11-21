import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { ApiError } from "@/lib/api"
import { useJoinCourse } from "@/lib/queries"
import { cn } from "@/lib/utils"

/** Invite-code entry from the approved "Join a course" card: code field + Join, with the error shown underneath. */
export function JoinCodeForm({ className, autoFocus }: { className?: string; autoFocus?: boolean }) {
  const navigate = useNavigate()
  const join = useJoinCourse()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!code.trim()) return setError("Enter the invite code from your instructor.")
    try {
      const course = await join.mutateAsync(code.trim())
      navigate(`/student/courses/${course.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : "We couldn't join that course. Try again.")
    }
  }

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col items-center gap-3", className)}>
      <div className="flex items-center gap-2.5">
        <label htmlFor="invite-code" className="sr-only">Invite code</label>
        <input id="invite-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="off" spellCheck={false} autoFocus={autoFocus}
          placeholder="ALG-7K2P" aria-invalid={!!error} aria-describedby={error ? "invite-error" : undefined}
          className="h-[42px] w-[172px] rounded-[12px] border border-[var(--color-control-border)] bg-white text-center text-[15px] font-semibold tracking-[0.2em] text-[var(--color-ink)] placeholder:font-medium placeholder:tracking-[0.2em] placeholder:text-[var(--color-ink-faint)]" />
        <button type="submit" className="ds-btn ds-btn-pri h-[42px]" disabled={join.isPending}>{join.isPending ? "Joining…" : "Join"}</button>
      </div>
      {error && <p id="invite-error" role="alert" className="ds-pill ds-pill-bad !font-medium">{error}</p>}
    </form>
  )
}

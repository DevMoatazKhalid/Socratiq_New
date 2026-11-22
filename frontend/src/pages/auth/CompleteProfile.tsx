import { useEffect, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { AuthLayout } from "@/components/layout/AuthLayout"
import { Input, Select } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { homeFor, useAuth } from "@/lib/auth"
import { fetchUniversities } from "@/lib/queries"
import { ApiError } from "@/lib/api"
import { Field } from "@/components/ui/Field"
import { fieldProps } from "@/components/ui/fieldProps"

/**
 * Shown only when someone is signed in but the profile could not be created automatically from what they entered at sign-up
 * (for example a wrong instructor access code, or an account made before sign-up stored its details). Everything already known is
 * pre-filled, and the role chosen at sign-up is kept: it cannot be switched here.
 */
export default function CompleteProfile() {
  const navigate = useNavigate()
  const { status, me, completeProfile, signOut, pending, error: authError } = useAuth()
  const [universities, setUniversities] = useState<{ id: string; name: string }[]>([])
  const roleFixed = Boolean(pending?.role)
  const [v, setV] = useState({
    firstName: pending?.firstName ?? "", lastName: pending?.lastName ?? "", role: pending?.role ?? "STUDENT",
    universityId: pending?.universityId ?? "", signupCode: "",
  })
  const [codeRequired, setCodeRequired] = useState(false)
  const needsCode = v.role === "PROFESSOR" && codeRequired
  const [error, setError] = useState<string | null>(authError)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchUniversities().then((r) => { setUniversities(r.universities); setCodeRequired(Boolean(r.teacherCodeRequired)) }).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (status === "ready" && me) navigate(homeFor(me.role), { replace: true })
    if (status === "signed_out") navigate("/login", { replace: true })
  }, [status, me, navigate])
  // Details can arrive after the first render (the account is still loading): fill only what the person has not typed yet.
  useEffect(() => {
    if (!pending) return
    setV((cur) => ({
      ...cur, role: pending.role,
      firstName: cur.firstName || pending.firstName, lastName: cur.lastName || pending.lastName, universityId: cur.universityId || pending.universityId,
    }))
  }, [pending])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!v.firstName.trim() || !v.lastName.trim()) return setError("Enter your first and last name.")
    if (!v.universityId) return setError("Choose your university.")
    if (needsCode && !v.signupCode.trim()) return setError("Enter the instructor access code from your institution.")
    setBusy(true)
    try {
      await completeProfile({ firstName: v.firstName.trim(), lastName: v.lastName.trim(), role: v.role as "STUDENT" | "PROFESSOR", universityId: v.universityId,
        ...(needsCode ? { signupCode: v.signupCode.trim() } : {}) })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "We couldn't finish setting up your account.")
      setBusy(false)
    }
  }

  const roleLabel = v.role === "PROFESSOR" ? "Instructor" : "Student"
  return (
    <AuthLayout wide>
      <h1 className="text-center font-serif text-[28px] font-bold leading-tight text-[var(--color-ink)]">Finish setting up your account</h1>
      <p className="mt-1 text-center text-sm text-[var(--color-ink-muted)]">
        {roleFixed ? `Your ${roleLabel.toLowerCase()} account is almost ready. Check the details below.` : "Tell us who you are to open your workspace."}
      </p>
      <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="cp-first" label="First name">
            <Input {...fieldProps("cp-first")} autoComplete="given-name" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
          </Field>
          <Field id="cp-last" label="Last name">
            <Input {...fieldProps("cp-last")} autoComplete="family-name" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
          </Field>
        </div>
        {roleFixed ? (
          <div>
            <p className="text-sm font-medium text-[var(--color-ink)]">Account type</p>
            <p className="mt-1 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5 text-sm text-[var(--color-ink)]">
              {roleLabel} <span className="text-[var(--color-ink-muted)]">· chosen when you signed up</span>
            </p>
          </div>
        ) : (
          <Field id="cp-role" label="I am a">
            <Select {...fieldProps("cp-role")} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as "STUDENT" | "PROFESSOR" })}>
              <option value="STUDENT">Student</option>
              <option value="PROFESSOR">Instructor</option>
            </Select>
          </Field>
        )}
        <Field id="cp-uni" label="University">
          <Select {...fieldProps("cp-uni")} value={v.universityId} onChange={(e) => setV({ ...v, universityId: e.target.value })}>
            <option value="">Select your university…</option>
            {universities.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        {needsCode && (
          <Field id="cp-code" label="Instructor access code" hint="Your institution gives this to instructors.">
            <Input {...fieldProps("cp-code")} autoComplete="off" value={v.signupCode} onChange={(e) => setV({ ...v, signupCode: e.target.value })} />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-danger-light)] px-3 py-2 text-sm text-[var(--color-danger-ink)]">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between pt-1">
          <button type="button" onClick={signOut} className="text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline">
            Log out
          </button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}

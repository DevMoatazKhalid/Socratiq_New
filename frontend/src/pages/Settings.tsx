import { AppShell } from "@/components/layout/AppShell"
import { PageTitle } from "@/components/ds"
import { useAuth } from "@/lib/auth"
import type { Role } from "@/types"

/** Settings (approved "E-settings"): the account as the identity provider has it. Read-only by design. */
export default function Settings({ role }: { role: Role }) {
  const { me, signOut } = useAuth()
  return (
    <AppShell role={role} crumbs={[{ label: "Settings" }]}>
      <PageTitle title="Settings" subtitle="Your account" />
      <section className="ds-card max-w-[620px] p-6" aria-labelledby="acct-h">
        <h2 id="acct-h" className="text-lg font-bold">Account</h2>
        <dl className="mt-4 space-y-4">
          <div><dt className="ds-label">Name</dt><dd><input className="ds-input bg-[var(--color-surface-muted)]" value={me?.name ?? ""} readOnly aria-label="Name" /></dd></div>
          <div><dt className="ds-label">Email</dt><dd><input className="ds-input bg-[var(--color-surface-muted)]" type="email" value={me?.email ?? ""} readOnly aria-label="Email" /></dd></div>
          <div><dt className="ds-label">Role</dt><dd className="text-sm">{role === "teacher" ? "Instructor" : "Student"}</dd></div>
        </dl>
        <p className="mt-4 text-[13px] text-[var(--color-ink-muted)]">Your name and email come from your account. Ask your institution's administrator to change them.</p>
        <button type="button" className="ds-btn mt-5" onClick={signOut}>Log out</button>
      </section>
    </AppShell>
  )
}

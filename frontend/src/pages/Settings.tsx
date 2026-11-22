import { AppShell } from "@/components/layout/AppShell"
import { PageTitle } from "@/components/ds"
import { useAuth } from "@/lib/auth"
import type { Role } from "@/types"
import { setMotivationPref, useMotivationPref, type MotivationPref } from "@/lib/motivation"

const PREFS: { value: MotivationPref; title: string; body: string }[] = [
  { value: "all", title: "Everything", body: "Celebrations for grades and milestones, plus gentle nudges like a break reminder after a long session." },
  { value: "milestones", title: "Milestones only", body: "Only real achievements: a new grade, a streak, assignments handed in, understanding verified." },
  { value: "off", title: "Off", body: "No popups. Your streak and progress still show on Home." },
]

/** How often SocratiQ shows encouragement. Stored on this device. */
function MotivationSettings() {
  const pref = useMotivationPref()
  return (
    <section id="motivation" className="ds-card mt-5 max-w-[620px] scroll-mt-24 p-6" aria-labelledby="mot-h">
      <h2 id="mot-h" className="text-lg font-bold">Encouragement & celebrations</h2>
      <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">SocratiQ celebrates your progress and helps you keep a steady rhythm. Choose how much you'd like to see.</p>
      <div className="mt-4 space-y-2" role="radiogroup" aria-labelledby="mot-h">
        {PREFS.map((p) => (
          <label key={p.value} className={`flex cursor-pointer items-start gap-3 rounded-[12px] border px-4 py-3 ${pref === p.value ? "border-[var(--color-plum)] bg-[var(--color-plum-light)]" : "border-[var(--color-border)]"}`}>
            <input type="radio" name="motivation" className="mt-1" checked={pref === p.value} onChange={() => setMotivationPref(p.value)} />
            <span><b className="text-sm">{p.title}</b><span className="mt-0.5 block text-xs text-[var(--color-ink-muted)]">{p.body}</span></span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-[var(--color-ink-muted)]">Saved on this device.</p>
    </section>
  )
}

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
      {role === "student" && <MotivationSettings />}
    </AppShell>
  )
}

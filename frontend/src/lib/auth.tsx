import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import type { Session } from "@supabase/supabase-js"
import { supabase, isConfigured } from "./supabase"
import { api, ApiError } from "./api"
import type { Role } from "@/types"

export interface Me {
  id: string
  name: string
  email: string
  role: Role
  universityId: string
  firstName?: string | null
  lastName?: string | null
}

export interface PendingProfile {
  firstName: string
  lastName: string
  role: "STUDENT" | "PROFESSOR"
  universityId: string
  /** Instructor access code, only when the deployment requires one. Kept with the pending profile until the profile is created. */
  signupCode?: string
}

type Status = "loading" | "signed_out" | "needs_profile" | "ready" | "error"

/** The sign-up choices also travel with the Supabase account (user_metadata), so the profile can be created on any device,
 *  e.g. after confirming the email on a phone. The instructor code is never stored there. */
function profileFromMetadata(meta: Record<string, unknown> | undefined): PendingProfile | null {
  if (!meta) return null
  const role = meta.socratiq_role
  const firstName = typeof meta.first_name === "string" ? meta.first_name : ""
  const lastName = typeof meta.last_name === "string" ? meta.last_name : ""
  const universityId = typeof meta.university_id === "string" ? meta.university_id : ""
  if ((role !== "STUDENT" && role !== "PROFESSOR") || !firstName || !lastName || !universityId) return null
  return { firstName, lastName, role, universityId }
}

function readPending(): PendingProfile | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as PendingProfile) : null
  } catch {
    return null
  }
}

interface AuthValue {
  status: Status
  me: Me | null
  error: string | null
  /** What the person chose at sign-up, when the profile could not be created automatically (pre-fills Complete Profile). */
  pending: PendingProfile | null
  signIn: (email: string, password: string) => Promise<void>
  /** Returns "signed_in" or "confirm_email" (project requires email confirmation before a session exists). */
  signUp: (email: string, password: string, profile: PendingProfile) => Promise<"signed_in" | "confirm_email">
  completeProfile: (p: PendingProfile) => Promise<void>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)
const PENDING_KEY = "socratiq.pendingProfile"   // profile fields only; the password is never stored

export function homeFor(role: Role) {
  return role === "teacher" ? "/teacher" : "/student"
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(isConfigured ? "loading" : "error")
  const [me, setMe] = useState<Me | null>(null)
  const [pending, setPending] = useState<PendingProfile | null>(null)
  const [error, setError] = useState<string | null>(isConfigured ? null : "This deployment is missing its Supabase settings (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).")
  const loading = useRef(false)

  const load = useCallback(async (session: Session | null) => {
    if (!session) {
      setMe(null)
      setStatus("signed_out")
      return
    }
    if (loading.current) return
    loading.current = true
    try {
      setMe(await api<Me>("/me"))
      setStatus("ready")
    } catch (e) {
      if (e instanceof ApiError && e.code === "profile_required") {
        // The choices made at sign-up: this browser's copy first (it can carry the instructor code), else the account's metadata.
        const local = readPending()
        const saved = local ?? profileFromMetadata(session.user?.user_metadata)
        if (saved) {
          try {
            await createProfile(saved)
            localStorage.removeItem(PENDING_KEY)
            setPending(null)
            setError(null)
            setMe(await api<Me>("/me"))
            setStatus("ready")
            return
          } catch (err) {
            if (err instanceof ApiError && err.code === "profile_exists") {      // created meanwhile (another tab or device)
              localStorage.removeItem(PENDING_KEY)
              setMe(await api<Me>("/me"))
              setStatus("ready")
              return
            }
            setError(err instanceof ApiError ? err.message : "We couldn't finish setting up your account.")
          }
        }
        // Only what is still missing is asked for: Complete Profile is pre-filled and keeps the role chosen at sign-up.
        setPending(saved)
        setMe(null)
        setStatus("needs_profile")
      } else if (e instanceof ApiError && e.status === 401) {
        await supabase.auth.signOut()
        setMe(null)
        setStatus("signed_out")
      } else {
        setError(e instanceof ApiError ? e.message : "Something went wrong.")
        setStatus("error")
      }
    } finally {
      loading.current = false
    }
  }, [])

  useEffect(() => {
    if (!isConfigured) return
    supabase.auth.getSession().then(({ data }) => load(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      void load(session)
    })
    return () => sub.subscription.unsubscribe()
  }, [load])

  const value = useMemo<AuthValue>(() => ({
    status, me, error, pending,
    async signIn(email, password) {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password })
      if (err) throw new Error(err.message === "Invalid login credentials" ? "That email and password don't match." : err.message)
    },
    async signUp(email, password, profile) {
      // Saved BEFORE the Supabase call: Supabase announces the new session while signUp is still running, and the profile must
      // already be there when that happens, otherwise the app would ask for the same details again.
      localStorage.setItem(PENDING_KEY, JSON.stringify(profile))
      setError(null)
      const { data, error: err } = await supabase.auth.signUp({
        email, password,
        options: { data: { first_name: profile.firstName, last_name: profile.lastName, university_id: profile.universityId, socratiq_role: profile.role } },
      })
      if (err) {
        localStorage.removeItem(PENDING_KEY)
        throw new Error(err.message)
      }
      return data.session ? "signed_in" : "confirm_email"
    },
    async completeProfile(p) {
      await createProfile(p)
      localStorage.removeItem(PENDING_KEY)
      setPending(null)
      setError(null)
      setMe(await api<Me>("/me"))
      setStatus("ready")
    },
    async signOut() {
      await supabase.auth.signOut()
      localStorage.removeItem(PENDING_KEY)
      setPending(null)
      setMe(null)
      setStatus("signed_out")
    },
    async resetPassword(email) {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/login` })
      if (err) throw new Error(err.message)
    },
  }), [status, me, error, pending])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

async function createProfile(p: PendingProfile) {
  await api("/auth/profile", {
    method: "POST",
    body: {
      first_name: p.firstName, last_name: p.lastName, role: p.role, university_id: p.universityId,
      ...(p.role === "PROFESSOR" && p.signupCode ? { signup_code: p.signupCode } : {}),
    },
  })
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext)
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>")
  return v
}

/** Route guard. Role is enforced by the backend as well; this only decides which UI to show. */
export function RequireAuth({ role, children }: { role: Role; children: ReactNode }) {
  const { status, me, error } = useAuth()
  const loc = useLocation()
  if (status === "loading") return <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-ink-soft)]">Loading…</div>
  if (status === "error") return <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-[var(--color-danger-ink)]">{error}</div>
  if (status === "signed_out") return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (status === "needs_profile") return <Navigate to="/complete-profile" replace />
  if (me && me.role !== role) return <Navigate to={homeFor(me.role)} replace />
  return <>{children}</>
}

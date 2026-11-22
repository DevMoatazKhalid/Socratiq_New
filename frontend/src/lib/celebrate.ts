import type { QueryClient } from "@tanstack/react-query"
import { fetchMomentum, type Momentum } from "./queries"
import { fromLocal, fromServer, showMoment } from "./motivation"

/** After a hand-in: a milestone if this submission reached one (first assignment, 5 handed in, a streak), else a "handed in" moment.
 *  Either way it points to the verification that comes next. Never throws: motivation must not get in the way of submitting. */
export async function celebrateSubmission(qc: QueryClient, a: { title: string; courseId: string; assignmentId: string }) {
  const verify = { label: "Start verification", to: `/student/courses/${a.courseId}/assignments/${a.assignmentId}/verify` }
  try {
    const m = await qc.fetchQuery<Momentum | null>({ queryKey: ["student", "momentum"], queryFn: fetchMomentum, staleTime: 0 })
    const milestone = m?.celebrations.find((c) => c.kind === "submissions" || c.kind === "streak")
    if (milestone && showMoment({ ...fromServer(milestone), cta: verify })) return
  } catch {
    /* older server or offline: the local moment below still acknowledges the work */
  }
  showMoment(fromLocal({ kind: "submitted", title: a.title, courseId: a.courseId, assignmentId: a.assignmentId }))
}

/** After the last verification answer. */
export async function celebrateVerification(qc: QueryClient, a: { title: string; passed: boolean }) {
  try {
    const m = await qc.fetchQuery<Momentum | null>({ queryKey: ["student", "momentum"], queryFn: fetchMomentum, staleTime: 0 })
    const milestone = a.passed ? m?.celebrations.find((c) => c.kind === "verified") : undefined
    if (milestone && showMoment(fromServer(milestone))) return
  } catch { /* see above */ }
  showMoment(fromLocal({ kind: "verified", title: a.title, passed: a.passed }))
}

/** On the student's home: the most important unseen celebration (a released grade first), if the governor allows one now. */
export function celebrateFromMomentum(m: Momentum | null | undefined) {
  const first = m?.celebrations[0]
  if (first) showMoment(fromServer(first))
}

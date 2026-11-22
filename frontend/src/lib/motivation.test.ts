// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  admit, dailyEncouragement, dismissMoment, fromLocal, fromServer, getMotivationPref, noteStudyActivity, resetMotivation, setMotivationPref,
  showMoment,
} from "./motivation"

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0)
const MIN = 60_000
const streak = (n: number) => fromServer({ key: `streak:${n}`, kind: "streak", value: n }, 1)
const grade = (id: string) => fromServer({ key: `grade:${id}`, kind: "grade", band: "strong", title: "Essay", percentage: 84 }, 1)
const submitted = (seed: number) => fromLocal({ kind: "submitted", title: "Lab 2" }, seed)

beforeEach(() => resetMotivation())
afterEach(() => resetMotivation())

describe("motivation governor", () => {
  it("allows one moment, then holds others back for a few minutes", () => {
    expect(admit(streak(3), T0)).toBe(true)
    expect(admit(fromServer({ key: "verified:1", kind: "verified", value: 1 }, 1), T0 + MIN)).toBe(false)
    expect(admit(fromServer({ key: "verified:1", kind: "verified", value: 1 }, 1), T0 + 4 * MIN)).toBe(true)
  })
  it("a released grade is information and is never held back by the gap or the daily cap", () => {
    for (let i = 0; i < 4; i++) expect(admit(streak(3 + i), T0 + i * 10 * MIN)).toBe(true)
    expect(admit(streak(30), T0 + 60 * MIN)).toBe(false)                // daily cap reached
    expect(admit(grade("a"), T0 + 41 * MIN)).toBe(true)
    expect(admit(grade("b"), T0 + 41 * MIN + 1000)).toBe(true)
  })
  it("acknowledges the student's own action even right after another moment", () => {
    expect(admit(streak(3), T0)).toBe(true)
    expect(admit(submitted(T0 + 1000), T0 + 1000)).toBe(true)
    expect(admit(fromLocal({ kind: "verified", title: "Lab 2", passed: true }, 2), T0 + 2000)).toBe(true)
    expect(admit(fromServer({ key: "verified:5", kind: "verified", value: 5 }, 1), T0 + 3000)).toBe(false)   // the milestone waits its turn
  })
  it("the daily cap resets after 24 hours", () => {
    for (let i = 0; i < 4; i++) admit(streak(3 + i), T0 + i * 10 * MIN)
    expect(admit(streak(60), T0 + 25 * 60 * MIN)).toBe(true)
  })
  it("respects the student's preference", () => {
    setMotivationPref("off")
    expect(getMotivationPref()).toBe("off")
    expect(admit(grade("a"), T0)).toBe(false)
    setMotivationPref("milestones")
    expect(admit(submitted(T0), T0)).toBe(false)                         // local nudges are off in milestones mode
    expect(admit(fromServer({ key: "comeback:2026-11-20", kind: "comeback" }, 1), T0)).toBe(false)
    expect(admit(streak(7), T0)).toBe(true)
  })
  it("the queue shows each moment once and drops it when dismissed", () => {
    const m = streak(7)
    expect(showMoment(m, T0)).toBe(true)
    expect(showMoment(m, T0 + 10 * MIN)).toBe(false)                     // already queued
    dismissMoment(m.id)
    expect(showMoment(streak(14), T0 + 20 * MIN)).toBe(true)
  })
})

describe("break nudge", () => {
  it("suggests a break after ~45 minutes of continuous work, then not again for two hours", () => {
    for (let t = 0; t <= 45; t += 5) noteStudyActivity(T0 + t * MIN)
    expect(admit(streak(3), T0 + 46 * MIN)).toBe(false)                                          // the nudge was just shown
    expect(admit(fromLocal({ kind: "break", minutes: 45 }, 1), T0 + 100 * MIN)).toBe(false)      // cool-down
    expect(admit(fromLocal({ kind: "break", minutes: 45 }, 2), T0 + 170 * MIN)).toBe(true)
  })
  it("a 20-minute pause starts a new session (no nudge)", () => {
    noteStudyActivity(T0)
    noteStudyActivity(T0 + 30 * MIN)        // idle gap > 20 min: new session
    noteStudyActivity(T0 + 50 * MIN)
    expect(admit(fromLocal({ kind: "break", minutes: 45 }, T0 + 51 * MIN), T0 + 51 * MIN)).toBe(true)
  })
})

describe("message libraries", () => {
  it("uses the real numbers and never repeats the same wording twice in a row", () => {
    const a = fromServer({ key: "streak:7", kind: "streak", value: 7 }, 0)
    const b = fromServer({ key: "streak:14", kind: "streak", value: 14 }, 0)
    expect(a.stat).toBe("7-day streak")
    expect(a.body).not.toBe(b.body.replace("14", "7"))
  })
  it("a lower grade is framed as encouragement, without confetti", () => {
    const m = fromServer({ key: "grade:x", kind: "grade", band: "growing", title: "Quiz", percentage: 42, courseId: "c1", assignmentId: "a1" }, 0)
    expect(m.tone).toBe("encourage")
    expect(m.confetti).toBe(false)
    expect(m.stat).toBe("42%")
    expect(m.cta?.to).toBe("/student/courses/c1/assignments/a1#grade")
  })
  it("the daily line is stable through the day and changes the next day", () => {
    const d1 = new Date(2026, 10, 20, 8), d1b = new Date(2026, 10, 20, 22), d2 = new Date(2026, 10, 21, 8)
    expect(dailyEncouragement(d1)).toBe(dailyEncouragement(d1b))
    expect(dailyEncouragement(d1)).not.toBe(dailyEncouragement(d2))
  })
})

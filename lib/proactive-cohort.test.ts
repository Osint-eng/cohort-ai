import { describe, expect, it } from "vitest"
import {
  buildNextNudgeState,
  computeDaysLeft,
  estimateDailyPulseReads,
  evaluateProactiveNudge,
  getLocalTodayIso,
  getNudgeBackoffMs,
  getPulseCheckIntervalMs,
  isTaskNudgeEligible,
  isWithinPulseCheckThrottle,
  normalizeTzOffsetMinutes,
  parseTaskDueDate,
} from "./proactive-cohort"

describe("Formula G1: pulse check throttle and daily read budget", () => {
  it("computes C = max(5 min, cooldownMs / 8) for low, medium, and high", () => {
    expect(getPulseCheckIntervalMs("low") / 60_000).toBe(90)
    expect(getPulseCheckIntervalMs("medium") / 60_000).toBe(30)
    expect(getPulseCheckIntervalMs("high") / 60_000).toBe(5.625)
  })

  it("matches the worked example: medium, 20 tasks, 5 members -> 48 checks * 28 reads = 1344 reads/day", () => {
    const result = estimateDailyPulseReads({
      aggressiveness: "medium",
      taskCount: 20,
      memberCount: 5,
    })

    expect(result.intervalMinutes).toBe(30)
    expect(result.checksPerDay).toBe(48)
    expect(result.readsPerCheck).toBe(28)
    expect(result.dailyReadsPerRoom).toBe(1344)
  })

  it("throttles medium rooms 10 minutes after a check and allows after 30 minutes", () => {
    const checkAt = "2026-11-27T12:00:00.000Z"
    const tenMinutesLater = Date.parse("2026-11-27T12:10:00.000Z")
    const thirtyMinutesLater = Date.parse("2026-11-27T12:30:00.000Z")

    expect(isWithinPulseCheckThrottle("medium", checkAt, tenMinutesLater)).toBe(true)
    expect(isWithinPulseCheckThrottle("medium", checkAt, thirtyMinutesLater)).toBe(false)
  })
})

describe("Formula G2: ISO dates and timezone", () => {
  it("computes local todayIso across UTC midnight (nowMs = 2026-11-27T19:00:00Z, tz = -330 -> 2026-11-28)", () => {
    const nowMs = Date.parse("2026-11-27T19:00:00Z")
    expect(getLocalTodayIso(nowMs, -330)).toBe("2026-11-28")
    expect(getLocalTodayIso(nowMs, 0)).toBe("2026-11-27")
  })

  it("computes daysLeft using end-of-day in client timezone (due 2026-11-28, tz = -330 -> ~0.979)", () => {
    const nowMs = Date.parse("2026-11-27T19:00:00Z")
    const daysLeft = computeDaysLeft("2026-11-28", nowMs, -330)
    expect(daysLeft).not.toBeNull()
    expect(daysLeft!).toBeCloseTo(0.979, 3)

    const overdueDaysLeft = computeDaysLeft("2026-11-27", nowMs, -330)
    expect(overdueDaysLeft!).toBeLessThan(0)
  })

  it("validates tzOffsetMinutes in [-840, 840] and keeps legacy 'Nov 20' fallback in parseTaskDueDate", () => {
    expect(normalizeTzOffsetMinutes(-330)).toBe(-330)
    expect(normalizeTzOffsetMinutes(840)).toBe(840)
    expect(normalizeTzOffsetMinutes(841)).toBe(0)
    expect(normalizeTzOffsetMinutes(-900)).toBe(0)
    expect(normalizeTzOffsetMinutes(12.5)).toBe(0)
    expect(normalizeTzOffsetMinutes("bad")).toBe(0)

    const legacy = parseTaskDueDate("Nov 20", Date.parse("2026-11-10T12:00:00Z"), 0)
    expect(legacy?.toISOString()).toBe("2026-11-20T23:59:59.000Z")
  })
})

describe("Formula G3: per-task nudge memory and exponential backoff", () => {
  const HOUR_MS = 3_600_000

  it("computes gap_n = min(24 h * 2^n, 7 d) for n = 0, 1, 2, 3", () => {
    expect(getNudgeBackoffMs(0) / HOUR_MS).toBe(24)
    expect(getNudgeBackoffMs(1) / HOUR_MS).toBe(48)
    expect(getNudgeBackoffMs(2) / HOUR_MS).toBe(96)
    expect(getNudgeBackoffMs(3) / HOUR_MS).toBe(168)
  })

  it("checks lastAt 30 h ago: n=0 -> eligible, n=1 -> not eligible", () => {
    const nowMs = Date.parse("2026-11-27T18:00:00Z")
    const thirtyHoursAgo = nowMs - 30 * HOUR_MS

    expect(isTaskNudgeEligible({ atMs: thirtyHoursAgo, n: 0 }, nowMs)).toBe(true)
    expect(isTaskNudgeEligible({ atMs: thirtyHoursAgo, n: 1 }, nowMs)).toBe(false)
  })

  it("skips a snoozed overdue task and selects the second overdue task", () => {
    const nowMs = Date.parse("2026-11-27T18:00:00Z")
    const result = evaluateProactiveNudge({
      aggressiveness: "medium",
      nowMs,
      tzOffsetMinutes: 0,
      nudgeState: {
        t1: { atMs: nowMs - 30 * HOUR_MS, n: 1 },
      },
      tasks: [
        {
          id: "t1",
          title: "First overdue task",
          suggested_owner: "@Alice",
          due_date: "2026-11-25",
          status: "todo",
        },
        {
          id: "t2",
          title: "Second overdue task",
          suggested_owner: "@Bob",
          due_date: "2026-11-26",
          status: "in_progress",
        },
      ],
      messages: [],
    })

    expect(result.shouldNudge).toBe(true)
    expect(result.reason).toBe("deadline_soon")
    expect(result.targetTaskId).toBe("t2")
  })

  it("drops nudgeState entries for done or deleted tasks and updates the nudged task", () => {
    const nowMs = Date.parse("2026-11-27T18:00:00Z")
    const next = buildNextNudgeState({
      currentState: {
        t1: { atMs: nowMs - 10 * HOUR_MS, n: 1 },
        t_done: { atMs: nowMs - 5 * HOUR_MS, n: 2 },
        t_deleted: { atMs: nowMs - 2 * HOUR_MS, n: 1 },
      },
      tasks: [
        { id: "t1", status: "todo" },
        { id: "t2", status: "in_progress" },
        { id: "t_done", status: "done" },
      ],
      nudgedTaskId: "t2",
      nowMs,
    })

    expect(Object.keys(next).sort()).toEqual(["t1", "t2"])
    expect(next.t2.n).toBe(1)
    expect(next.t2.at).toEqual(new Date(nowMs))
  })
})

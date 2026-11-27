import { describe, expect, it } from "vitest"
import {
  estimateDailyPulseReads,
  getPulseCheckIntervalMs,
  isWithinPulseCheckThrottle,
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

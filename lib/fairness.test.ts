import { describe, expect, it } from "vitest"
import type { LogEntry, Member, Task } from "./api"
import {
  buildFairnessCsv,
  computeDecayedCompletionPoints,
  computeDecayedStartPoints,
  computeFairnessReport,
  escapeCsvCell,
} from "./fairness"

const NOW_MS = Date.parse("2026-11-26T18:00:00.000Z")

function makeMember(uid: string, name: string, role: Member["role"] = "member"): Member {
  return {
    uid,
    name,
    photoURL: "",
    role,
    status: role === "pending" ? "pending" : "active",
    online: true,
    lastSeenAt: new Date(NOW_MS - 10 * 60_000).toISOString(),
  }
}

function makeTask(
  id: string,
  overrides: Partial<Task> = {}
): Task {
  return {
    id,
    title: `Task ${id}`,
    suggested_owner: "@Alice",
    owner_uid: "u1",
    due_date: "2026-11-30",
    status: "todo",
    ...overrides,
  }
}

function makeLog(
  id: string,
  actorId: string,
  actor: string,
  action: string,
  task_id: string,
  secondsAgo: number
): LogEntry {
  return {
    id,
    actorId,
    actor,
    action,
    task_id,
    ts: new Date(NOW_MS - secondsAgo * 1_000).toISOString(),
  }
}

describe("computeFairnessReport", () => {
  it("keeps log-credited points when the board is replaced with new tasks", () => {
    const alice = makeMember("u1", "Alice", "owner")
    const bob = makeMember("u2", "Bob")

    const logs: LogEntry[] = [
      makeLog("l1", "u1", "Alice", "started", "t1", 120),
      makeLog("l2", "u1", "Alice", "completed", "t1", 90),
      makeLog("l3", "u2", "Bob", "started", "t2", 80),
      makeLog("l4", "u2", "Bob", "completed", "t2", 60),
    ]

    // Board was replaced: old t1/t2 are gone, replaced by fresh todo tasks t3/t4
    const replacedTasks: Task[] = [
      makeTask("t3", { owner_uid: "u1", suggested_owner: "@Alice", status: "todo" }),
      makeTask("t4", { owner_uid: "u2", suggested_owner: "@Bob", status: "todo" }),
    ]

    const report = computeFairnessReport({
      members: [alice, bob],
      tasks: replacedTasks,
      logs,
      nowMs: NOW_MS,
    })

    const aliceRow = report.members.find((m) => m.member.uid === "u1")
    const bobRow = report.members.find((m) => m.member.uid === "u2")

    expect(aliceRow?.points).toBe(4) // +1 started + 3 completed
    expect(bobRow?.points).toBe(4) // +1 started + 3 completed
    expect(report.fairnessScore).toBe(100)
    expect(report.fairnessLabel).toBe("Balanced")
  })

  it("awards nothing extra when toggling done and todo ten times", () => {
    const alice = makeMember("u1", "Alice", "owner")
    const bob = makeMember("u2", "Bob")
    const tasks: Task[] = [
      makeTask("t1", { owner_uid: "u1", suggested_owner: "@Alice", status: "done" }),
    ]

    const logs: LogEntry[] = [
      makeLog("l0", "u1", "Alice", "completed", "t1", 200),
    ]

    for (let i = 0; i < 10; i++) {
      logs.push(makeLog(`lt_${i}`, "u1", "Alice", "moved to to do", "t1", 180 - i * 2))
      logs.push(makeLog(`ld_${i}`, "u1", "Alice", "completed", "t1", 179 - i * 2))
    }

    const report = computeFairnessReport({
      members: [alice, bob],
      tasks,
      logs,
      nowMs: NOW_MS,
    })

    const aliceRow = report.members.find((m) => m.member.uid === "u1")
    const bobRow = report.members.find((m) => m.member.uid === "u2")

    expect(aliceRow?.points).toBe(3)
    expect(bobRow?.points).toBe(0)
  })

  it("credits the actor rather than the task owner when someone else marks a task done", () => {
    const alice = makeMember("u1", "Alice", "owner")
    const bob = makeMember("u2", "Bob")

    // Task t1 is assigned to Alice, but Bob started and completed it
    const tasks: Task[] = [
      makeTask("t1", { owner_uid: "u1", suggested_owner: "@Alice", status: "done" }),
    ]

    const logs: LogEntry[] = [
      makeLog("l1", "u2", "Bob", "started", "t1", 30),
      makeLog("l2", "u2", "Bob", "completed", "t1", 10),
    ]

    const report = computeFairnessReport({
      members: [alice, bob],
      tasks,
      logs,
      nowMs: NOW_MS,
    })

    const aliceRow = report.members.find((m) => m.member.uid === "u1")
    const bobRow = report.members.find((m) => m.member.uid === "u2")

    expect(bobRow?.points).toBe(4) // +1 started + 3 completed
    expect(aliceRow?.points).toBe(0) // owner without logs gets 0
    expect(report.fairnessScore).toBe(50) // Jain's index: 4^2 / (2 * 4^2) = 0.5 -> 50
  })

  it("credits the earliest chronological actor even when logs arrive newest-first and deduplicates starts", () => {
    const alice = makeMember("u1", "Alice", "owner")
    const bob = makeMember("u2", "Bob")

    const logsNewestFirst: LogEntry[] = [
      makeLog("l4", "u2", "Bob", "completed", "t1", 5),
      makeLog("l3", "u2", "Bob", "started", "t1", 10),
      makeLog("l2", "u1", "Alice", "completed", "t1", 20),
      makeLog("l1", "u1", "Alice", "started", "t1", 30),
    ]

    const report = computeFairnessReport({
      members: [alice, bob],
      tasks: [makeTask("t1", { status: "done" })],
      logs: logsNewestFirst,
      nowMs: NOW_MS,
    })

    const aliceRow = report.members.find((m) => m.member.uid === "u1")
    const bobRow = report.members.find((m) => m.member.uid === "u2")

    expect(aliceRow?.points).toBe(4)
    expect(bobRow?.points).toBe(0)
  })

  it("multiplies completion points by task weight (1 to 3) and caps other actions at 2", () => {
    const alice = makeMember("u1", "Alice", "owner")
    const bob = makeMember("u2", "Bob")

    const tasks: Task[] = [
      makeTask("t1", { owner_uid: "u1", suggested_owner: "@Alice", status: "done", weight: 3 }),
      makeTask("t2", { owner_uid: "u2", suggested_owner: "@Bob", status: "done", weight: 2 }),
    ]

    const logs: LogEntry[] = [
      makeLog("l1", "u1", "Alice", "completed", "t1", 50), // 3 * 3 = 9
      makeLog("l2", "u2", "Bob", "completed", "t2", 40), // 3 * 2 = 6
      // 10 other logged actions for Bob — should add at most 2
      ...Array.from({ length: 10 }, (_, idx) =>
        makeLog(`le_${idx}`, "u2", "Bob", idx % 2 === 0 ? "edited" : "reassigned", "t2", 30 - idx)
      ),
    ]

    const report = computeFairnessReport({
      members: [alice, bob],
      tasks,
      logs,
      nowMs: NOW_MS,
    })

    const aliceRow = report.members.find((m) => m.member.uid === "u1")
    const bobRow = report.members.find((m) => m.member.uid === "u2")

    expect(aliceRow?.points).toBe(9)
    expect(bobRow?.points).toBe(8) // 6 + 2 cap
    expect(report.fairnessScore).toBe(100) // (17^2) / (2 * (81 + 64)) = 289 / 290 = 0.9965 -> 100
  })

  it("ignores synthetic @cohort bot logs when calculating points", () => {
    const alice = makeMember("u1", "Alice", "owner")

    const logs: LogEntry[] = [
      makeLog("bot1", "cohort", "cohort", "created", "board", 20),
      makeLog("u1_done", "u1", "Alice", "completed", "t1", 10),
    ]

    const report = computeFairnessReport({
      members: [alice],
      tasks: [makeTask("t1", { status: "done" })],
      logs,
      nowMs: NOW_MS,
    })

    expect(report.totalLogs).toBe(1)
    expect(report.members[0]?.points).toBe(3)
    expect(report.fairnessScore).toBe(100)
  })
})

describe("Formula G5: CSV formula injection guard", () => {
  it("prefixes dangerous string cells with a single quote while leaving safe strings and numbers unchanged", () => {
    expect(escapeCsvCell("=1+1")).toBe("'=1+1")
    expect(escapeCsvCell("+91 77")).toBe("'+91 77")
    expect(escapeCsvCell("-cmd")).toBe("'-cmd")
    expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)")
    expect(escapeCsvCell("\tfoo")).toBe("'\tfoo")
    expect(escapeCsvCell("\rbar")).toBe("'\rbar")
    expect(escapeCsvCell("Priya")).toBe("Priya")
    expect(escapeCsvCell(5)).toBe("5")
    expect(escapeCsvCell(-5)).toBe("-5")
    expect(escapeCsvCell('=1+1, "hi"')).toBe('"\'=1+1, ""hi"""')
  })

  it("escapes member names and room titles in buildFairnessCsv", () => {
    const alice = makeMember("u1", "=1+1", "owner")
    const bob = makeMember("u2", "+91 77")
    const priya = makeMember("u3", "Priya")
    const report = computeFairnessReport({
      members: [alice, bob, priya],
      tasks: [makeTask("t1", { status: "done" })],
      logs: [makeLog("l1", "u3", "Priya", "completed", "t1", 10)],
      nowMs: NOW_MS,
    })

    const csv = buildFairnessCsv("ROOM1234", "@EvilTitle", report)
    const lines = csv.split("\n")
    expect(lines.some((line) => line.startsWith("ROOM1234,'@EvilTitle,'=1+1,"))).toBe(true)
    expect(lines.some((line) => line.startsWith("ROOM1234,'@EvilTitle,'+91 77,"))).toBe(true)
    expect(lines.some((line) => line.startsWith("ROOM1234,'@EvilTitle,Priya,"))).toBe(true)
  })
})

describe("Formula G9: recency decay in fairness", () => {
  it("decays weight-1 completion points to 3 at age 0, 1.5 at age 7, and 0.75 at age 14", () => {
    expect(computeDecayedCompletionPoints(1, 0)).toBe(3)
    expect(computeDecayedCompletionPoints(1, 7)).toBe(1.5)
    expect(computeDecayedCompletionPoints(1, 14)).toBe(0.75)
    expect(computeDecayedStartPoints(0)).toBe(1)
    expect(computeDecayedStartPoints(7)).toBe(0.5)
    expect(computeDecayedStartPoints(14)).toBe(0.25)

    const makeAtAgeDays = (id: string, uid: string, name: string, ageDays: number): LogEntry => ({
      id,
      actorId: uid,
      actor: name,
      action: "completed",
      task_id: `t_${ageDays}`,
      ts: new Date(NOW_MS - ageDays * 86_400_000).toISOString(),
    })

    for (const [ageDays, expected] of [
      [0, 3],
      [7, 1.5],
      [14, 0.75],
    ] as const) {
      const alice = makeMember("u1", "Alice", "owner")
      const report = computeFairnessReport({
        members: [alice],
        tasks: [makeTask(`t_${ageDays}`, { status: "done", weight: 1 })],
        logs: [makeAtAgeDays(`l_${ageDays}`, "u1", "Alice", ageDays)],
        nowMs: NOW_MS,
      })
      expect(report.members[0]?.points).toBe(expected)
    }
  })

  it("preserves the exact fairness score when all members have equal log ages", () => {
    const alice = makeMember("u1", "Alice", "owner")
    const bob = makeMember("u2", "Bob")
    const tasks: Task[] = [
      makeTask("t1", { owner_uid: "u1", status: "done", weight: 1 }),
      makeTask("t2", { owner_uid: "u1", status: "done", weight: 1 }),
      makeTask("t3", { owner_uid: "u2", status: "done", weight: 1 }),
    ]

    const logsAtAge = (ageDays: number): LogEntry[] => {
      const ts = new Date(NOW_MS - ageDays * 86_400_000).toISOString()
      return [
        { id: "l1", actorId: "u1", actor: "Alice", action: "started", task_id: "t1", ts },
        { id: "l2", actorId: "u1", actor: "Alice", action: "completed", task_id: "t1", ts },
        { id: "l3", actorId: "u1", actor: "Alice", action: "completed", task_id: "t2", ts },
        { id: "l4", actorId: "u2", actor: "Bob", action: "completed", task_id: "t3", ts },
      ]
    }

    // Without decay (age 0): Alice = 7, Bob = 3 -> J = (10^2) / (2 * (49 + 9)) = 100 / 116 -> 86
    const baseline = computeFairnessReport({
      members: [alice, bob],
      tasks,
      logs: logsAtAge(0),
      nowMs: NOW_MS,
    })
    const aged7 = computeFairnessReport({
      members: [alice, bob],
      tasks,
      logs: logsAtAge(7),
      nowMs: NOW_MS,
    })
    const aged14 = computeFairnessReport({
      members: [alice, bob],
      tasks,
      logs: logsAtAge(14),
      nowMs: NOW_MS,
    })

    expect(baseline.fairnessScore).toBe(86)
    expect(aged7.fairnessScore).toBe(baseline.fairnessScore)
    expect(aged14.fairnessScore).toBe(baseline.fairnessScore)
  })
})


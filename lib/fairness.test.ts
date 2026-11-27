import { describe, expect, it } from "vitest"
import type { LogEntry, Member, Task } from "./api"
import { computeFairnessReport } from "./fairness"

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
  minutesAgo: number
): LogEntry {
  return {
    id,
    actorId,
    actor,
    action,
    task_id,
    ts: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
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

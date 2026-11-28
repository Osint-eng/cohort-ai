import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FirestoreConflictError } from "@/lib/server-firebase"

const mocks = vi.hoisted(() => ({
  verifyFirebaseIdToken: vi.fn(),
  fsGetDocumentWithMeta: vi.fn(),
  fsGetDocument: vi.fn(),
  fsListCollection: vi.fn(),
  fsRunQuery: vi.fn(),
  fsCommit: vi.fn(),
  enforceUserRateLimit: vi.fn(),
  generateProactiveNudgeWithGemini: vi.fn(),
}))

vi.mock("@/lib/server-firebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-firebase")>()
  return {
    ...actual,
    verifyFirebaseIdToken: mocks.verifyFirebaseIdToken,
    fsGetDocumentWithMeta: mocks.fsGetDocumentWithMeta,
    fsGetDocument: mocks.fsGetDocument,
    fsListCollection: mocks.fsListCollection,
    fsRunQuery: mocks.fsRunQuery,
    fsCommit: mocks.fsCommit,
  }
})

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>()
  return {
    ...actual,
    enforceUserRateLimit: mocks.enforceUserRateLimit,
  }
})

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>()
  return {
    ...actual,
    generateProactiveNudgeWithGemini: mocks.generateProactiveNudgeWithGemini,
  }
})

import { POST } from "./route"

describe("POST /api/cohort/pulse", () => {
  const nowMs = Date.parse("2026-11-27T12:10:00.000Z")

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)
    Object.values(mocks).forEach((fn) => fn.mockReset())

    mocks.verifyFirebaseIdToken.mockResolvedValue({
      uid: "user_1",
      displayName: "Alice",
      photoURL: "",
      email: "alice@example.com",
      idToken: "tok_1",
    })
    mocks.fsGetDocument.mockResolvedValue({
      uid: "user_1",
      role: "owner",
      status: "active",
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns early with zero list reads 10 minutes after lastPulseCheckAt in medium mode", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce({
      data: {
        code: "ROOM1234",
        title: "Capstone",
        agentAggressiveness: "medium",
        agentStatus: "watching",
        lastPulseCheckAt: "2026-11-27T12:00:00.000Z",
        createdAt: "2026-11-20T00:00:00.000Z",
      },
      updateTime: "2026-11-27T12:00:00.000Z",
    })

    const req = new NextRequest("http://localhost:3000/api/cohort/pulse", {
      method: "POST",
      headers: {
        authorization: "Bearer tok_1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ roomCode: "ROOM1234" }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, nudged: false })
    expect(mocks.fsListCollection).not.toHaveBeenCalled()
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
    expect(mocks.fsCommit).not.toHaveBeenCalled()
  })

  it("writes lastPulseCheckAt with ifMatchUpdateTime on a healthy empty board without listing members or querying messages", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce({
      data: {
        code: "ROOM1234",
        title: "Capstone",
        agentAggressiveness: "medium",
        agentStatus: "watching",
        lastPulseCheckAt: "2026-11-27T11:30:00.000Z",
        createdAt: "2026-11-27T11:00:00.000Z",
      },
      updateTime: "2026-11-27T11:30:00.000Z",
    })
    mocks.fsListCollection.mockResolvedValueOnce([])
    mocks.fsCommit.mockRejectedValueOnce(new FirestoreConflictError("conflict"))

    const req = new NextRequest("http://localhost:3000/api/cohort/pulse", {
      method: "POST",
      headers: {
        authorization: "Bearer tok_1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ roomCode: "ROOM1234" }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, nudged: false })
    expect(mocks.fsListCollection).toHaveBeenCalledTimes(1)
    expect(mocks.fsListCollection).toHaveBeenCalledWith("rooms/ROOM1234/tasks", "tok_1")
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
    expect(mocks.enforceUserRateLimit).not.toHaveBeenCalled()
    expect(mocks.fsCommit).toHaveBeenCalledWith(
      [
        {
          type: "update",
          path: "rooms/ROOM1234",
          data: { agentStatus: "watching" },
          serverTimestampFields: ["lastPulseCheckAt", "updatedAt"],
          updateMaskFields: ["agentStatus"],
          ifMatchUpdateTime: "2026-11-27T11:30:00.000Z",
        },
      ],
      "tok_1"
    )
  })

  it("queries latest message for healthy open tasks but skips listing members when no nudge fires", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce({
      data: {
        code: "ROOM1234",
        title: "Capstone",
        agentAggressiveness: "medium",
        agentStatus: "watching",
        lastPulseCheckAt: "2026-11-27T11:30:00.000Z",
        createdAt: "2026-11-20T00:00:00.000Z",
      },
      updateTime: "2026-11-27T11:30:00.000Z",
    })
    mocks.fsListCollection.mockResolvedValueOnce([
      {
        docId: "t1",
        data: {
          id: "t1",
          title: "Future task",
          suggested_owner: "@Alice",
          due_date: "2026-12-20",
          status: "in_progress",
        },
      },
    ])
    mocks.fsRunQuery.mockResolvedValueOnce([
      {
        docId: "m1",
        data: {
          role: "user",
          senderId: "user_1",
          createdAt: "2026-11-27T11:50:00.000Z",
        },
      },
    ])
    mocks.fsCommit.mockResolvedValueOnce(undefined)

    const req = new NextRequest("http://localhost:3000/api/cohort/pulse", {
      method: "POST",
      headers: {
        authorization: "Bearer tok_1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ roomCode: "ROOM1234", tzOffsetMinutes: 0 }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, nudged: false })
    expect(mocks.fsListCollection).toHaveBeenCalledTimes(1)
    expect(mocks.fsListCollection).toHaveBeenCalledWith("rooms/ROOM1234/tasks", "tok_1")
    expect(mocks.fsRunQuery).toHaveBeenCalledTimes(1)
    expect(mocks.enforceUserRateLimit).not.toHaveBeenCalled()
  })

  it("skips snoozed overdue task, nudges second overdue task, and persists nudgeState in same commit", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce({
      data: {
        code: "ROOM1234",
        title: "Capstone",
        agentAggressiveness: "medium",
        agentStatus: "watching",
        nudgeState: {
          t1: { at: "2026-11-26T06:10:00.000Z", n: 1 },
          t_done: { at: "2026-11-26T06:10:00.000Z", n: 1 },
        },
        createdAt: "2026-11-20T00:00:00.000Z",
      },
      updateTime: "2026-11-27T07:00:00.000Z",
    })
    mocks.fsListCollection
      .mockResolvedValueOnce([
        {
          docId: "t1",
          data: {
            id: "t1",
            title: "Snoozed overdue task",
            suggested_owner: "@Alice",
            due_date: "2026-11-25",
            status: "todo",
          },
        },
        {
          docId: "t2",
          data: {
            id: "t2",
            title: "Eligible overdue task",
            suggested_owner: "@Bob",
            due_date: "2026-11-26",
            status: "in_progress",
          },
        },
        {
          docId: "t_done",
          data: {
            id: "t_done",
            title: "Completed task",
            suggested_owner: "@Alice",
            due_date: "2026-11-24",
            status: "done",
          },
        },
      ])
      .mockResolvedValueOnce([{ docId: "user_1", data: { uid: "user_1", displayName: "Alice", role: "owner" } }])
    mocks.enforceUserRateLimit.mockResolvedValueOnce(undefined)
    mocks.generateProactiveNudgeWithGemini.mockResolvedValueOnce("Heads up on t2!")
    mocks.fsCommit.mockResolvedValueOnce(undefined)

    const req = new NextRequest("http://localhost:3000/api/cohort/pulse", {
      method: "POST",
      headers: {
        authorization: "Bearer tok_1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ roomCode: "ROOM1234", tzOffsetMinutes: 0 }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, nudged: true, reason: "deadline_soon" })
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
    expect(mocks.fsListCollection).toHaveBeenCalledTimes(2)
    expect(mocks.enforceUserRateLimit).toHaveBeenCalledWith("user_1", "tok_1", "cohort")
    const commitWrites = mocks.fsCommit.mock.calls[0]?.[0] as Array<{
      data?: { nudgeState?: Record<string, { at: Date; n: number }> }
      updateMaskFields?: string[]
    }>
    expect(commitWrites[0]?.updateMaskFields).toEqual(["agentStatus", "nudgeState"])
    expect(Object.keys(commitWrites[0]?.data?.nudgeState || {}).sort()).toEqual(["t1", "t2"])
    expect(commitWrites[0]?.data?.nudgeState?.t2).toEqual({
      at: new Date(nowMs),
      n: 1,
    })
  })
})

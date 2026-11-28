import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RateLimitError } from "@/lib/rate-limit"

const mocks = vi.hoisted(() => ({
  verifyFirebaseIdToken: vi.fn(),
  fsGetDocument: vi.fn(),
  fsListCollection: vi.fn(),
  fsRunQuery: vi.fn(),
  fsCommit: vi.fn(),
  enforceUserRateLimit: vi.fn(),
  extractBoardWithGemini: vi.fn(),
  generateCheckInWithGemini: vi.fn(),
  generateCohortReplyWithGemini: vi.fn(),
}))

vi.mock("@/lib/server-firebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-firebase")>()
  return {
    ...actual,
    verifyFirebaseIdToken: mocks.verifyFirebaseIdToken,
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
    extractBoardWithGemini: mocks.extractBoardWithGemini,
    generateCheckInWithGemini: mocks.generateCheckInWithGemini,
    generateCohortReplyWithGemini: mocks.generateCohortReplyWithGemini,
  }
})

import { POST } from "./route"

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3000/api/cohort", {
    method: "POST",
    headers: {
      authorization: "Bearer tok_1",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

describe("POST /api/cohort scoped Firestore reads", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset())

    mocks.verifyFirebaseIdToken.mockResolvedValue({
      uid: "user_1",
      displayName: "Alice",
      photoURL: "",
      email: "alice@example.com",
      idToken: "tok_1",
    })
    mocks.enforceUserRateLimit.mockResolvedValue(undefined)
    mocks.fsCommit.mockResolvedValue(undefined)
    mocks.fsGetDocument.mockImplementation(async (path: string) => {
      if (path === "rooms/ROOM1234") {
        return {
          code: "ROOM1234",
          title: "Capstone",
          summary: "Build product",
          ownerId: "user_1",
          nextTaskNumber: 2,
        }
      }
      if (path === "rooms/ROOM1234/members/user_1") {
        return {
          uid: "user_1",
          displayName: "Alice",
          role: "owner",
          status: "active",
        }
      }
      if (path === "rooms/ROOM1234/tasks/t1") {
        return {
          id: "t1",
          title: "Set up schema",
          suggested_owner: "@Alice",
          owner_uid: "user_1",
          due_date: "2026-12-01",
          status: "todo",
          updatedBy: "user_1",
        }
      }
      return null
    })
  })

  it("@cohort help performs zero collection LIST or query reads while preserving rate limit", async () => {
    const res = await POST(makeRequest({ roomCode: "ROOM1234", messageText: "@cohort help" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(mocks.enforceUserRateLimit).toHaveBeenCalledWith("user_1", "tok_1", "cohort")
    expect(mocks.fsGetDocument).toHaveBeenCalledTimes(2)
    expect(mocks.fsListCollection).not.toHaveBeenCalled()
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
    expect(mocks.fsCommit).toHaveBeenCalledTimes(1)
  })

  it("@cohort mark t1 complete fetches only the single task doc and never lists members or tasks", async () => {
    const res = await POST(
      makeRequest({ roomCode: "ROOM1234", messageText: "@cohort mark t1 complete" })
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(mocks.fsGetDocument).toHaveBeenCalledWith("rooms/ROOM1234/tasks/t1", "tok_1")
    expect(mocks.fsListCollection).not.toHaveBeenCalled()
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
    expect(mocks.fsCommit).toHaveBeenCalledTimes(1)
  })

  it("@cohort list reads tasks only and skips listing members", async () => {
    mocks.fsListCollection.mockResolvedValueOnce([
      {
        docId: "t1",
        data: {
          id: "t1",
          title: "Set up schema",
          suggested_owner: "@Alice",
          due_date: "2026-12-01",
          status: "todo",
        },
      },
    ])

    const res = await POST(makeRequest({ roomCode: "ROOM1234", messageText: "@cohort list" }))
    expect(res.status).toBe(200)
    expect(mocks.fsListCollection).toHaveBeenCalledTimes(1)
    expect(mocks.fsListCollection).toHaveBeenCalledWith("rooms/ROOM1234/tasks", "tok_1")
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
  })

  it("@cohort extract without brief performs zero collection LIST reads", async () => {
    const res = await POST(makeRequest({ roomCode: "ROOM1234", messageText: "@cohort extract" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, promptForBrief: true })
    expect(mocks.fsListCollection).not.toHaveBeenCalled()
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
  })

  it("@cohort extract <brief> reads tasks and members and creates extracted tasks", async () => {
    mocks.fsListCollection
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { docId: "user_1", data: { uid: "user_1", displayName: "Alice", role: "owner" } },
      ])
    mocks.extractBoardWithGemini.mockResolvedValueOnce({
      summary: "Sprint plan",
      tasks: [
        {
          id: "t2",
          title: "Build dashboard",
          task_type: "frontend",
          weight: 2,
          suggested_owner: "@Alice",
          owner_uid: "user_1",
          due_date: "2026-12-03",
          status: "todo",
        },
      ],
    })

    const res = await POST(
      makeRequest({ roomCode: "ROOM1234", messageText: "@cohort extract Build the analytics dashboard" })
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(mocks.fsListCollection).toHaveBeenNthCalledWith(1, "rooms/ROOM1234/tasks", "tok_1")
    expect(mocks.fsListCollection).toHaveBeenNthCalledWith(2, "rooms/ROOM1234/members", "tok_1")
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
  })

  it("@cohort check-in reads tasks and members and skips message history", async () => {
    mocks.fsListCollection
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { docId: "user_1", data: { uid: "user_1", displayName: "Alice", role: "owner" } },
      ])
    mocks.generateCheckInWithGemini.mockResolvedValueOnce("All clear!")

    const res = await POST(makeRequest({ roomCode: "ROOM1234", messageText: "@cohort check-in" }))
    expect(res.status).toBe(200)
    expect(mocks.fsListCollection).toHaveBeenNthCalledWith(1, "rooms/ROOM1234/tasks", "tok_1")
    expect(mocks.fsListCollection).toHaveBeenNthCalledWith(2, "rooms/ROOM1234/members", "tok_1")
    expect(mocks.fsRunQuery).not.toHaveBeenCalled()
  })

  it("general @cohort Q&A reads tasks, members, and recent messages", async () => {
    mocks.fsListCollection
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { docId: "user_1", data: { uid: "user_1", displayName: "Alice", role: "owner" } },
      ])
    mocks.fsRunQuery.mockResolvedValueOnce([])
    mocks.generateCohortReplyWithGemini.mockResolvedValueOnce("Here is the status.")

    const res = await POST(
      makeRequest({ roomCode: "ROOM1234", messageText: "@cohort what is left?" })
    )
    expect(res.status).toBe(200)
    expect(mocks.fsListCollection).toHaveBeenCalledTimes(2)
    expect(mocks.fsRunQuery).toHaveBeenCalledTimes(1)
  })

  it("preserves rate limit enforcement and returns 429 with Retry-After", async () => {
    mocks.enforceUserRateLimit.mockRejectedValueOnce(new RateLimitError("Slow down", 42))

    const res = await POST(makeRequest({ roomCode: "ROOM1234", messageText: "@cohort help" }))
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("42")
    expect(mocks.fsGetDocument).not.toHaveBeenCalled()
    expect(mocks.fsListCollection).not.toHaveBeenCalled()
  })
})

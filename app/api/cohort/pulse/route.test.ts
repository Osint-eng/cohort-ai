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

  it("writes lastPulseCheckAt with ifMatchUpdateTime on a healthy check and returns nudged:false on conflict", async () => {
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
    mocks.fsListCollection.mockResolvedValue([])
    mocks.fsRunQuery.mockResolvedValueOnce([])
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
    expect(mocks.fsListCollection).toHaveBeenCalledTimes(2)
    expect(mocks.fsRunQuery).toHaveBeenCalledTimes(1)
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
})

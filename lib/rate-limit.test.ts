import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FirestoreConflictError } from "./server-firebase"

const mocks = vi.hoisted(() => ({
  fsGetDocumentWithMeta: vi.fn(),
  fsCommit: vi.fn(),
}))

vi.mock("./server-firebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-firebase")>()
  return {
    ...actual,
    fsGetDocumentWithMeta: mocks.fsGetDocumentWithMeta,
    fsCommit: mocks.fsCommit,
  }
})

import { enforceUserRateLimit, RateLimitError } from "./rate-limit"

describe("enforceUserRateLimit", () => {
  const nowMs = Date.parse("2026-11-26T20:00:00.000Z")

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)
    mocks.fsGetDocumentWithMeta.mockReset()
    mocks.fsCommit.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("creates rateLimits/{uid} when missing", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce(null)
    mocks.fsCommit.mockResolvedValueOnce(undefined)

    await enforceUserRateLimit("user_1", "tok", "room")

    expect(mocks.fsGetDocumentWithMeta).toHaveBeenCalledWith("rateLimits/user_1", "tok")
    expect(mocks.fsCommit).toHaveBeenCalledWith(
      [
        {
          type: "create",
          path: "rateLimits/user_1",
          data: {
            uid: "user_1",
            roomCount: 1,
            cohortCount: 0,
          },
          serverTimestampFields: ["roomWindowStart", "cohortWindowStart", "updatedAt"],
        },
      ],
      "tok"
    )
  })

  it("increments existing counter using ifMatchUpdateTime within active window", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce({
      data: {
        uid: "user_1",
        roomWindowStart: new Date(nowMs - 60_000).toISOString(),
        roomCount: 2,
        cohortWindowStart: new Date(nowMs - 60_000).toISOString(),
        cohortCount: 5,
      },
      updateTime: "2026-11-26T19:59:00.000Z",
    })
    mocks.fsCommit.mockResolvedValueOnce(undefined)

    await enforceUserRateLimit("user_1", "tok", "cohort")

    expect(mocks.fsCommit).toHaveBeenCalledWith(
      [
        {
          type: "update",
          path: "rateLimits/user_1",
          data: { cohortCount: 6 },
          updateMaskFields: ["cohortCount"],
          serverTimestampFields: ["updatedAt"],
          ifMatchUpdateTime: "2026-11-26T19:59:00.000Z",
        },
      ],
      "tok"
    )
  })

  it("throws RateLimitError when limit is reached within 10-minute window", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce({
      data: {
        uid: "user_1",
        roomWindowStart: new Date(nowMs - 120_000).toISOString(),
        roomCount: 10,
        cohortWindowStart: new Date(nowMs - 120_000).toISOString(),
        cohortCount: 20,
      },
      updateTime: "2026-11-26T19:58:00.000Z",
    })

    await expect(enforceUserRateLimit("user_1", "tok", "room")).rejects.toThrow(RateLimitError)
    expect(mocks.fsCommit).not.toHaveBeenCalled()
  })

  it("resets window and sets count to 1 after 10 minutes", async () => {
    mocks.fsGetDocumentWithMeta.mockResolvedValueOnce({
      data: {
        uid: "user_1",
        roomWindowStart: new Date(nowMs - 10 * 60_000).toISOString(),
        roomCount: 10,
        cohortWindowStart: new Date(nowMs - 60_000).toISOString(),
        cohortCount: 20,
      },
      updateTime: "2026-11-26T19:50:00.000Z",
    })
    mocks.fsCommit.mockResolvedValueOnce(undefined)

    await enforceUserRateLimit("user_1", "tok", "room")

    expect(mocks.fsCommit).toHaveBeenCalledWith(
      [
        {
          type: "update",
          path: "rateLimits/user_1",
          data: { roomCount: 1 },
          updateMaskFields: ["roomCount"],
          serverTimestampFields: ["roomWindowStart", "updatedAt"],
          ifMatchUpdateTime: "2026-11-26T19:50:00.000Z",
        },
      ],
      "tok"
    )
  })

  it("retries once on FirestoreConflictError and succeeds on retry", async () => {
    mocks.fsGetDocumentWithMeta
      .mockResolvedValueOnce({
        data: {
          uid: "user_1",
          roomWindowStart: new Date(nowMs - 30_000).toISOString(),
          roomCount: 1,
          cohortWindowStart: new Date(nowMs - 30_000).toISOString(),
          cohortCount: 1,
        },
        updateTime: "2026-11-26T19:59:30.000Z",
      })
      .mockResolvedValueOnce({
        data: {
          uid: "user_1",
          roomWindowStart: new Date(nowMs - 30_000).toISOString(),
          roomCount: 1,
          cohortWindowStart: new Date(nowMs - 30_000).toISOString(),
          cohortCount: 2,
        },
        updateTime: "2026-11-26T19:59:45.000Z",
      })

    mocks.fsCommit
      .mockRejectedValueOnce(new FirestoreConflictError("conflict"))
      .mockResolvedValueOnce(undefined)

    await enforceUserRateLimit("user_1", "tok", "cohort")

    expect(mocks.fsGetDocumentWithMeta).toHaveBeenCalledTimes(2)
    expect(mocks.fsCommit).toHaveBeenCalledTimes(2)
    expect(mocks.fsCommit).toHaveBeenLastCalledWith(
      [
        {
          type: "update",
          path: "rateLimits/user_1",
          data: { cohortCount: 3 },
          updateMaskFields: ["cohortCount"],
          serverTimestampFields: ["updatedAt"],
          ifMatchUpdateTime: "2026-11-26T19:59:45.000Z",
        },
      ],
      "tok"
    )
  })
})

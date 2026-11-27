import { beforeEach, describe, expect, it, vi } from "vitest"

const firestoreMocks = vi.hoisted(() => {
  const getDoc = vi.fn()
  const deleteDoc = vi.fn()
  const getDocs = vi.fn()
  const onSnapshot = vi.fn(() => vi.fn())
  const collection = vi.fn((_db: unknown, ...segments: string[]) => ({
    kind: "collection",
    path: segments.join("/"),
  }))
  const doc = vi.fn((_db: unknown, ...segments: string[]) => ({
    kind: "doc",
    path: segments.join("/"),
  }))
  const orderBy = vi.fn((field: string, dir: string) => ({ kind: "orderBy", field, dir }))
  const limit = vi.fn((n: number) => ({ kind: "limit", n }))
  const startAfter = vi.fn((cursor: unknown) => ({ kind: "startAfter", cursor }))
  const where = vi.fn((field: string, op: string, value: unknown) => ({
    kind: "where",
    field,
    op,
    value,
  }))
  const query = vi.fn((target: unknown, ...constraints: unknown[]) => ({
    kind: "query",
    target,
    constraints,
  }))

  const serverTimestamp = vi.fn(() => ({ kind: "serverTimestamp" }))
  const batchDelete = vi.fn()
  const batchSet = vi.fn()
  const batchUpdate = vi.fn()
  const batchCommit = vi.fn(async () => undefined)
  const writeBatch = vi.fn(() => ({
    delete: batchDelete,
    set: batchSet,
    update: batchUpdate,
    commit: batchCommit,
  }))

  return {
    getDoc,
    deleteDoc,
    getDocs,
    onSnapshot,
    collection,
    doc,
    orderBy,
    limit,
    startAfter,
    where,
    query,
    serverTimestamp,
    writeBatch,
    batchDelete,
    batchSet,
    batchUpdate,
    batchCommit,
  }
})

vi.mock("./firebase", () => ({
  db: { mocked: true },
  OperationType: {
    CREATE: "create",
    UPDATE: "update",
    DELETE: "delete",
    LIST: "list",
    GET: "get",
    WRITE: "write",
  },
  handleFirestoreError: vi.fn((err: unknown) => {
    throw err instanceof Error ? err : new Error(String(err))
  }),
}))

vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  deleteDoc: firestoreMocks.deleteDoc,
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  getDocs: firestoreMocks.getDocs,
  increment: vi.fn(),
  limit: firestoreMocks.limit,
  onSnapshot: firestoreMocks.onSnapshot,
  orderBy: firestoreMocks.orderBy,
  query: firestoreMocks.query,
  runTransaction: vi.fn(),
  serverTimestamp: firestoreMocks.serverTimestamp,
  setDoc: vi.fn(),
  startAfter: firestoreMocks.startAfter,
  Timestamp: class MockTimestamp {
    private readonly date: Date
    constructor(date: Date) {
      this.date = date
    }
    static fromDate(date: Date) {
      return new MockTimestamp(date)
    }
    toDate() {
      return this.date
    }
  },
  updateDoc: vi.fn(),
  where: firestoreMocks.where,
  writeBatch: firestoreMocks.writeBatch,
}))

import {
  ACTIVITY_LOG_LIMIT,
  computeRejectionCooldownMs,
  computeRejectionUntilDate,
  ensureRoomMembership,
  estimateRoomOpenReads,
  formatMessageWindowAscending,
  getRecentRoomsStorageKey,
  leaveRoomMembership,
  loadOlderMessages,
  mergeFairnessLogs,
  mergeLiveMessages,
  mergeOlderMessages,
  MESSAGE_WINDOW_LIMIT,
  OLDER_MESSAGES_PAGE_SIZE,
  RECENT_ROOMS_LIMIT,
  RejectedCooldownError,
  rejectPendingMember,
  shouldFallbackToRedirectSignIn,
  subscribeToRoom,
  upsertRecentRoom,
  type LogEntry,
  type Member,
  type Message,
  type MessageCursor,
} from "./api"
import { computeFairnessReport } from "./fairness"

function makeMessage(index: number): Message {
  const ts = new Date(Date.UTC(2026, 10, 27, 0, index, 0)).toISOString()
  return {
    id: `m${index}`,
    senderId: "u1",
    name: "Alice",
    text: `Message ${index}`,
    ts,
    role: "user",
  }
}

describe("bounded room listeners and pagination helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("formatMessageWindowAscending returns the newest 100 messages in ascending order", () => {
    // Descending order as returned by Firestore orderBy('createdAt', 'desc'): m120 .. m1
    const descMessages = Array.from({ length: 120 }, (_, idx) => makeMessage(120 - idx))
    const windowed = formatMessageWindowAscending(descMessages, MESSAGE_WINDOW_LIMIT)

    expect(windowed).toHaveLength(100)
    expect(windowed[0]?.id).toBe("m21")
    expect(windowed[99]?.id).toBe("m120")
  })

  it("loadOlderMessages fetches 50 older items via startAfter(cursor) and merges without duplicates", async () => {
    const olderDescDocs = Array.from({ length: 50 }, (_, idx) => {
      const n = 50 - idx // m50 down to m1
      const msg = makeMessage(n)
      return {
        id: msg.id,
        data: () => ({
          id: msg.id,
          senderId: msg.senderId,
          senderName: msg.name,
          text: msg.text,
          createdAt: msg.ts,
          role: msg.role,
        }),
      }
    })

    firestoreMocks.getDocs.mockResolvedValueOnce({
      docs: olderDescDocs,
    })

    const fakeCursor = { id: "m51" } as unknown as MessageCursor
    const page = await loadOlderMessages("ROOM1234", fakeCursor, OLDER_MESSAGES_PAGE_SIZE)

    expect(firestoreMocks.orderBy).toHaveBeenCalledWith("createdAt", "desc")
    expect(firestoreMocks.startAfter).toHaveBeenCalledWith(fakeCursor)
    expect(firestoreMocks.limit).toHaveBeenCalledWith(50)
    expect(page.messages).toHaveLength(50)
    expect(page.messages[0]?.id).toBe("m1")
    expect(page.messages[49]?.id).toBe("m50")
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe(olderDescDocs[49])

    const existingWindow = Array.from({ length: 100 }, (_, idx) => makeMessage(51 + idx)) // m51..m150
    const merged = mergeOlderMessages(existingWindow, [
      ...page.messages,
      makeMessage(51), // simulate overlap duplicate
      makeMessage(50), // duplicate inside older page
    ])

    expect(merged).toHaveLength(150)
    expect(merged[0]?.id).toBe("m1")
    expect(merged[49]?.id).toBe("m50")
    expect(merged[50]?.id).toBe("m51")
    expect(merged[149]?.id).toBe("m150")
    expect(new Set(merged.map((m) => m.id)).size).toBe(150)

    // Subsequent live snapshot sliding forward keeps loaded older messages m1..m51 intact
    const slidLive = Array.from({ length: 100 }, (_, idx) => makeMessage(52 + idx)) // m52..m151
    const afterLive = mergeLiveMessages(merged, slidLive)
    expect(afterLive).toHaveLength(151)
    expect(afterLive[0]?.id).toBe("m1")
    expect(afterLive[150]?.id).toBe("m151")
    expect(new Set(afterLive.map((m) => m.id)).size).toBe(151)
  })

  it("subscribeToRoom bounds messages and activity logs to 100 and opens a separate fairness logs listener", () => {
    const unsub = subscribeToRoom("AB12CD34", {
      onRoom: vi.fn(),
      onMembers: vi.fn(),
      onMessages: vi.fn(),
      onMessagesMeta: vi.fn(),
      onTasks: vi.fn(),
      onLogs: vi.fn(),
      onFairnessLogs: vi.fn(),
      onNotFound: vi.fn(),
      onError: vi.fn(),
    })

    const queriedTargets = firestoreMocks.query.mock.calls.map((call) => ({
      path: (call[0] as { path: string }).path,
      constraints: call.slice(1) as Array<Record<string, unknown>>,
    }))

    const messagesQuery = queriedTargets.find((q) => q.path === "rooms/AB12CD34/messages")
    expect(messagesQuery?.constraints).toEqual([
      { kind: "orderBy", field: "createdAt", dir: "desc" },
      { kind: "limit", n: MESSAGE_WINDOW_LIMIT },
    ])

    const logsQueries = queriedTargets.filter((q) => q.path === "rooms/AB12CD34/logs")
    expect(logsQueries).toHaveLength(2)

    const activityQuery = logsQueries.find((q) =>
      q.constraints.some((c) => c.kind === "limit")
    )
    expect(activityQuery?.constraints).toEqual([
      { kind: "orderBy", field: "createdAt", dir: "desc" },
      { kind: "limit", n: ACTIVITY_LOG_LIMIT },
    ])

    const fairnessQuery = logsQueries.find((q) =>
      q.constraints.some((c) => c.kind === "where")
    )
    expect(fairnessQuery?.constraints).toEqual([
      { kind: "where", field: "action", op: "in", value: ["completed", "started"] },
    ])

    unsub()
  })

  it("mergeFairnessLogs preserves old completed/started logs outside the 100-item feed without duplicates", () => {
    const members: Member[] = [
      {
        uid: "u1",
        name: "Alice",
        photoURL: "",
        role: "owner",
        status: "active",
        online: true,
        lastSeenAt: "2026-11-27T10:00:00.000Z",
      },
      {
        uid: "u2",
        name: "Bob",
        photoURL: "",
        role: "member",
        status: "active",
        online: true,
        lastSeenAt: "2026-11-27T10:00:00.000Z",
      },
    ]

    const oldCompleted: LogEntry = {
      id: "log_old_1",
      actorId: "u1",
      actor: "Alice",
      action: "completed",
      task_id: "t1",
      ts: "2026-11-20T10:00:00.000Z",
    }
    const recentCompleted: LogEntry = {
      id: "log_recent_1",
      actorId: "u2",
      actor: "Bob",
      action: "completed",
      task_id: "t2",
      ts: "2026-11-27T09:00:00.000Z",
    }
    const recentOther: LogEntry = {
      id: "log_recent_2",
      actorId: "u2",
      actor: "Bob",
      action: "reassigned",
      task_id: "t2",
      ts: "2026-11-27T09:30:00.000Z",
    }

    const merged = mergeFairnessLogs(
      [recentOther, recentCompleted],
      [recentCompleted, oldCompleted]
    )

    expect(merged.map((l) => l.id)).toEqual([
      "log_recent_2",
      "log_recent_1",
      "log_old_1",
    ])

    const report = computeFairnessReport({
      members,
      tasks: [],
      logs: merged,
      nowMs: Date.parse("2026-11-27T10:00:00.000Z"),
    })
    const alice = report.members.find((m) => m.member.uid === "u1")
    const bob = report.members.find((m) => m.member.uid === "u2")
    expect(alice?.points).toBe(1.5)
    expect(bob?.points).toBe(3.49)
  })

  it("Formula G4: estimates openReads as 266 for 100+100+20+5+1+40", () => {
    expect(
      estimateRoomOpenReads({
        messageLimit: 100,
        activityLimit: 100,
        tasksCount: 20,
        membersCount: 5,
        fairnessLogsCount: 40,
      })
    ).toBe(266)
  })
})

describe("leaveRoomMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects when the caller is the room owner and does not delete their member doc", async () => {
    firestoreMocks.getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ ownerId: "owner_1" }),
    })

    await expect(
      leaveRoomMembership("ROOM1234", { uid: "owner_1" } as never)
    ).rejects.toThrow("Transfer ownership is not available yet")

    expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled()
  })

  it("deletes the member doc when the caller is a normal member", async () => {
    firestoreMocks.getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ ownerId: "owner_1" }),
    })
    firestoreMocks.deleteDoc.mockResolvedValueOnce(undefined)

    await expect(
      leaveRoomMembership("ROOM1234", { uid: "member_2" } as never)
    ).resolves.toBeUndefined()

    expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1)
    expect(firestoreMocks.deleteDoc).toHaveBeenCalledWith({
      kind: "doc",
      path: "rooms/ROOM1234/members/member_2",
    })
  })
})

describe("rejected user cooldown (Formula G7)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("Formula G7: scales cooldown exponentially from 15 min and caps at 24 h", () => {
    const min = 60 * 1000
    const hour = 60 * min

    expect(computeRejectionCooldownMs(1)).toBe(15 * min)
    expect(computeRejectionCooldownMs(2)).toBe(30 * min)
    expect(computeRejectionCooldownMs(3)).toBe(60 * min)
    expect(computeRejectionCooldownMs(4)).toBe(120 * min)
    expect(computeRejectionCooldownMs(8)).toBe(24 * hour)
    expect(computeRejectionCooldownMs(9)).toBe(24 * hour)

    const rejectedAt = Date.parse("2026-11-27T12:00:00.000Z")
    expect(computeRejectionUntilDate(rejectedAt, 3).toISOString()).toBe(
      "2026-11-27T13:00:00.000Z"
    )
  })

  it("rejectPendingMember deletes member doc and writes/increments blocked/{uid}", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-11-27T12:00:00.000Z"))

      // First rejection: blocked doc does not exist yet
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => false,
      })

      await rejectPendingMember("ROOM1234", "bob_uid")

      expect(firestoreMocks.batchDelete).toHaveBeenCalledWith({
        kind: "doc",
        path: "rooms/ROOM1234/members/bob_uid",
      })
      expect(firestoreMocks.batchSet).toHaveBeenCalledWith(
        { kind: "doc", path: "rooms/ROOM1234/blocked/bob_uid" },
        expect.objectContaining({
          uid: "bob_uid",
          count: 1,
        })
      )
      const firstSetPayload = firestoreMocks.batchSet.mock.calls[0]?.[1] as {
        until: { toDate: () => Date }
      }
      expect(firstSetPayload.until.toDate().toISOString()).toBe("2026-11-27T12:15:00.000Z")
      expect(firestoreMocks.batchCommit).toHaveBeenCalledTimes(1)

      vi.clearAllMocks()

      // Third rejection (prevCount = 2 -> k = 3 -> 60 min)
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ uid: "bob_uid", count: 2 }),
      })

      await rejectPendingMember("ROOM1234", "bob_uid")

      expect(firestoreMocks.batchUpdate).toHaveBeenCalledWith(
        { kind: "doc", path: "rooms/ROOM1234/blocked/bob_uid" },
        expect.objectContaining({
          count: 3,
        })
      )
      const updatePayload = firestoreMocks.batchUpdate.mock.calls[0]?.[1] as {
        until: { toDate: () => Date }
      }
      expect(updatePayload.until.toDate().toISOString()).toBe("2026-11-27T13:00:00.000Z")
      expect(firestoreMocks.batchCommit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ensureRoomMembership throws RejectedCooldownError when blocked until future time", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-11-27T12:00:00.000Z"))

      firestoreMocks.getDoc
        .mockResolvedValueOnce({
          exists: () => true,
          data: () => ({
            code: "ROOM1234",
            title: "Capstone",
            summary: "",
            ownerId: "owner_1",
          }),
        })
        .mockResolvedValueOnce({
          exists: () => false,
        })
        .mockResolvedValueOnce({
          exists: () => true,
          data: () => ({
            uid: "bob_uid",
            count: 1,
            until: "2026-11-27T12:15:00.000Z",
          }),
        })

      await expect(
        ensureRoomMembership("ROOM1234", {
          uid: "bob_uid",
          displayName: "Bob",
          email: "bob@example.com",
          photoURL: "",
        } as never)
      ).rejects.toThrowError(RejectedCooldownError)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("recent rooms (Formula G8) and sign-in redirect fallback", () => {
  it("Formula G8: keys by uid and moves revisited room to front while capping at 8", () => {
    expect(getRecentRoomsStorageKey("uid_1")).toBe("cohort:recentRooms:uid_1")
    expect(getRecentRoomsStorageKey("uid_2")).toBe("cohort:recentRooms:uid_2")

    const room = (code: string) => ({ code, title: `Room ${code}` })

    let list: Array<{ code: string; title: string }> = []
    list = upsertRecentRoom(list, room("A"))
    list = upsertRecentRoom(list, room("B"))
    list = upsertRecentRoom(list, room("C"))
    list = upsertRecentRoom(list, room("B"))

    expect(list.map((r) => r.code)).toEqual(["B", "C", "A"])

    // Add 5 more distinct codes (total 8): D, E, F, G, H
    for (const code of ["D", "E", "F", "G", "H"]) {
      list = upsertRecentRoom(list, room(code))
    }
    expect(list).toHaveLength(RECENT_ROOMS_LIMIT)
    expect(list.map((r) => r.code)).toEqual(["H", "G", "F", "E", "D", "B", "C", "A"])

    // Adding a 9th distinct code drops the oldest ("A")
    list = upsertRecentRoom(list, room("I"))
    expect(list).toHaveLength(RECENT_ROOMS_LIMIT)
    expect(list.map((r) => r.code)).toEqual(["I", "H", "G", "F", "E", "D", "B", "C"])
  })

  it("falls back to redirect only on popup-blocked, unsupported env, or web-storage-unsupported", () => {
    expect(shouldFallbackToRedirectSignIn({ code: "auth/popup-blocked" })).toBe(true)
    expect(
      shouldFallbackToRedirectSignIn({ code: "auth/operation-not-supported-in-this-environment" })
    ).toBe(true)
    expect(shouldFallbackToRedirectSignIn({ code: "auth/web-storage-unsupported" })).toBe(true)

    expect(shouldFallbackToRedirectSignIn({ code: "auth/popup-closed-by-user" })).toBe(false)
    expect(shouldFallbackToRedirectSignIn({ code: "auth/cancelled-popup-request" })).toBe(false)
    expect(shouldFallbackToRedirectSignIn({ code: "auth/network-request-failed" })).toBe(false)
  })
})



import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_FILE_SIZE_BYTES, MAX_ROOM_FILES } from "@/lib/room-files"

const mocks = vi.hoisted(() => ({
  verifyFirebaseIdToken: vi.fn(),
  fsGetDocument: vi.fn(),
  fsListCollection: vi.fn(),
  fsCommit: vi.fn(),
  enforceUserRateLimit: vi.fn(),
}))

vi.mock("@/lib/server-firebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-firebase")>()
  return {
    ...actual,
    verifyFirebaseIdToken: mocks.verifyFirebaseIdToken,
    fsGetDocument: mocks.fsGetDocument,
    fsListCollection: mocks.fsListCollection,
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

import { POST } from "./route"

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3000/api/cohort/git/import", {
    method: "POST",
    headers: {
      authorization: "Bearer tok_1",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

const originalFetch = globalThis.fetch

describe("POST /api/cohort/git/import", () => {
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
    mocks.fsListCollection.mockResolvedValue([])
    mocks.fsGetDocument.mockImplementation(async (path: string) => {
      if (path === "rooms/ROOM1234") {
        return { code: "ROOM1234", title: "Capstone", ownerId: "owner_1" }
      }
      if (path === "rooms/ROOM1234/members/user_1") {
        return { uid: "user_1", displayName: "Alice", role: "member", status: "active" }
      }
      return null
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("rejects pending or non-members with 403", async () => {
    mocks.fsGetDocument.mockImplementation(async (path: string) => {
      if (path === "rooms/ROOM1234") return { code: "ROOM1234", ownerId: "owner_1" }
      if (path === "rooms/ROOM1234/members/user_1") return { uid: "user_1", role: "pending" }
      return null
    })

    const res = await POST(
      makeRequest({ roomCode: "ROOM1234", repoUrl: "https://github.com/octocat/Hello-World" })
    )
    expect(res.status).toBe(403)
    expect(mocks.fsCommit).not.toHaveBeenCalled()
  })

  it("rejects non-GitHub or non-HTTPS URLs with 400", async () => {
    const res = await POST(
      makeRequest({ roomCode: "ROOM1234", repoUrl: "http://gitlab.com/foo/bar" })
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 for private or missing repositories", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response("Not Found", { status: 404 }))

    const res = await POST(
      makeRequest({ roomCode: "ROOM1234", repoUrl: "https://github.com/org/private-repo" })
    )
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toMatch(/private|public/i)
  })

  it("filters binaries, node_modules, oversized blobs and caps total imported files at 30", async () => {
    // Seed 29 existing files so only 1 new slot remains
    mocks.fsListCollection.mockResolvedValueOnce(
      Array.from({ length: MAX_ROOM_FILES - 1 }, (_, i) => ({
        docId: `file_existing_${i}`,
        data: { id: `file_existing_${i}`, path: `existing/f${i}.txt` },
      }))
    )

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/repos/octocat/Hello-World")) {
        return Response.json({ private: false, default_branch: "main" })
      }
      if (url.includes("/git/trees/main")) {
        return Response.json({
          tree: [
            { path: "README.md", type: "blob", sha: "sha_readme", size: 20 },
            { path: "src/extra.ts", type: "blob", sha: "sha_extra", size: 20 }, // over 30 cap
            { path: "node_modules/pkg/index.js", type: "blob", sha: "sha_nm", size: 10 },
            { path: ".git/HEAD", type: "blob", sha: "sha_git", size: 10 },
            { path: "assets/logo.png", type: "blob", sha: "sha_png", size: 500 },
            { path: "huge.txt", type: "blob", sha: "sha_huge", size: MAX_FILE_SIZE_BYTES + 10 },
          ],
        })
      }
      if (url.endsWith("/git/blobs/sha_readme")) {
        return Response.json({
          encoding: "base64",
          content: Buffer.from("# Hello World\n", "utf8").toString("base64"),
        })
      }
      return new Response("Unexpected fetch", { status: 500 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await POST(
      makeRequest({ roomCode: "ROOM1234", repoUrl: "https://github.com/octocat/Hello-World" })
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      ok: true,
      importedCount: 1,
      skippedCount: 5,
      totalFiles: 30,
      branch: "main",
      repo: "octocat/Hello-World",
    })
    expect(mocks.fsCommit).toHaveBeenCalledTimes(1)
    const writes = mocks.fsCommit.mock.calls[0][0]
    expect(writes).toHaveLength(2) // 1 file write + 1 activity log
    expect(writes[0].data.path).toBe("README.md")
  })
})

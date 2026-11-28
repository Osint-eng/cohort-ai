import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  return new NextRequest("http://localhost:3000/api/cohort/git/push", {
    method: "POST",
    headers: {
      authorization: "Bearer tok_1",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

const originalFetch = globalThis.fetch

describe("POST /api/cohort/git/push", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset())

    mocks.verifyFirebaseIdToken.mockResolvedValue({
      uid: "owner_1",
      displayName: "Owner",
      photoURL: "",
      email: "owner@example.com",
      idToken: "tok_1",
    })
    mocks.enforceUserRateLimit.mockResolvedValue(undefined)
    mocks.fsCommit.mockResolvedValue(undefined)
    mocks.fsGetDocument.mockImplementation(async (path: string) => {
      if (path === "rooms/ROOM1234") {
        return { code: "ROOM1234", title: "Capstone", ownerId: "owner_1" }
      }
      if (path === "rooms/ROOM1234/members/owner_1") {
        return { uid: "owner_1", displayName: "Owner", role: "owner", status: "active" }
      }
      if (path === "rooms/ROOM1234/members/member_2") {
        return { uid: "member_2", displayName: "Bob", role: "member", status: "active" }
      }
      return null
    })
    mocks.fsListCollection.mockResolvedValue([
      {
        docId: "file_1",
        data: {
          id: "file_1",
          path: "README.md",
          content: "# Updated Readme\n",
        },
      },
    ])
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("rejects non-owner members with 403", async () => {
    mocks.verifyFirebaseIdToken.mockResolvedValueOnce({
      uid: "member_2",
      displayName: "Bob",
      photoURL: "",
      email: "bob@example.com",
      idToken: "tok_2",
    })

    const res = await POST(
      makeRequest({
        roomCode: "ROOM1234",
        repoUrl: "https://github.com/octocat/Hello-World",
        branch: "main",
        pat: "ghp_testtoken1234567890",
      })
    )
    expect(res.status).toBe(403)
    expect(mocks.fsListCollection).not.toHaveBeenCalled()
  })

  it("returns 401 when GitHub rejects the personal access token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))

    const res = await POST(
      makeRequest({
        roomCode: "ROOM1234",
        repoUrl: "https://github.com/octocat/Hello-World",
        branch: "main",
        pat: "ghp_invalidtoken123456",
      })
    )
    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body.error).toMatch(/invalid github personal access token/i)
  })

  it("creates commit with required message, returns commitUrl, and never writes PAT to Firestore", async () => {
    const patSecret = "ghp_super_secret_token_value_1234"
    let capturedCommitMessage = ""

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/repos/octocat/Hello-World")) {
        return Response.json({ private: false })
      }
      if (url.endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { sha: "base_commit_sha" } })
      }
      if (url.endsWith("/git/commits/base_commit_sha")) {
        return Response.json({ tree: { sha: "base_tree_sha" } })
      }
      if (url.endsWith("/git/trees") && init?.method === "POST") {
        return Response.json({ sha: "new_tree_sha" })
      }
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body || "{}")) as { message?: string }
        capturedCommitMessage = parsed.message || ""
        return Response.json({
          sha: "new_commit_sha",
          html_url: "https://github.com/octocat/Hello-World/commit/new_commit_sha",
        })
      }
      if (url.endsWith("/git/refs/heads/main") && init?.method === "PATCH") {
        return Response.json({ ref: "refs/heads/main" })
      }
      return new Response("Unexpected fetch", { status: 500 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await POST(
      makeRequest({
        roomCode: "ROOM1234",
        repoUrl: "https://github.com/octocat/Hello-World",
        branch: "main",
        pat: patSecret,
      })
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(capturedCommitMessage).toBe("chore(cohort): sync room files from ROOM1234")
    expect(body).toEqual({
      ok: true,
      commitUrl: "https://github.com/octocat/Hello-World/commit/new_commit_sha",
      commitSha: "new_commit_sha",
      filesCount: 1,
      branch: "main",
      repo: "octocat/Hello-World",
    })
    expect(JSON.stringify(mocks.fsCommit.mock.calls)).not.toContain(patSecret)
    expect(JSON.stringify(body)).not.toContain(patSecret)
  })
})

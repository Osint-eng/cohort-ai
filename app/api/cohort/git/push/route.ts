import crypto from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import {
  AuthVerificationError,
  fsCommit,
  fsGetDocument,
  fsListCollection,
  verifyFirebaseIdToken,
} from "@/lib/server-firebase"
import { enforceUserRateLimit, RateLimitError } from "@/lib/rate-limit"
import {
  normalizeGitBranch,
  normalizeRoomFilePath,
  parseGitHubRepoUrl,
  validateRoomFileInput,
} from "@/lib/room-files"

const ROOM_CODE_REGEX = /^[A-Z0-9]{8}$/
const GITHUB_API_BASE = "https://api.github.com"

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

function githubAuthHeaders(pat: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${pat}`,
    "Content-Type": "application/json",
    "User-Agent": "Cohort-AI-App",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))
    await enforceUserRateLimit(user.uid, user.idToken, "cohort")

    const body = (await req.json().catch(() => ({}))) as {
      roomCode?: unknown
      repoUrl?: unknown
      branch?: unknown
      pat?: unknown
    }

    const roomCode = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : ""
    if (!ROOM_CODE_REGEX.test(roomCode)) {
      return NextResponse.json({ error: "Invalid room code" }, { status: 400 })
    }

    const parsedRepo = parseGitHubRepoUrl(typeof body.repoUrl === "string" ? body.repoUrl : "")
    if (!parsedRepo) {
      return NextResponse.json(
        {
          error:
            "Enter a valid HTTPS GitHub repository URL (for example, https://github.com/owner/repo).",
        },
        { status: 400 }
      )
    }

    let targetBranch = "main"
    try {
      targetBranch = normalizeGitBranch(body.branch, "main")
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid branch name." },
        { status: 400 }
      )
    }

    // Keep PAT strictly in-memory for this request; never persist or log it.
    const pat = typeof body.pat === "string" ? body.pat.trim() : ""
    if (!pat || pat.length < 10 || pat.length > 300 || /\s/.test(pat)) {
      return NextResponse.json(
        { error: "Enter a valid GitHub Personal Access Token." },
        { status: 400 }
      )
    }

    const [roomData, memberData] = await Promise.all([
      fsGetDocument(`rooms/${roomCode}`, user.idToken),
      fsGetDocument(`rooms/${roomCode}/members/${user.uid}`, user.idToken),
    ])

    if (!roomData) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }
    if (!memberData || (memberData.role !== "owner" && roomData.ownerId !== user.uid)) {
      return NextResponse.json(
        { error: "Only the room owner can push room files to Git." },
        { status: 403 }
      )
    }

    const fileDocs = await fsListCollection(`rooms/${roomCode}/files`, user.idToken)
    if (fileDocs.length === 0) {
      return NextResponse.json(
        { error: "There are no project files in this room to push." },
        { status: 400 }
      )
    }

    const treeEntries: Array<{
      path: string
      mode: "100644"
      type: "blob"
      content: string
    }> = []

    for (const d of fileDocs) {
      const rawPath = typeof d.data.path === "string" ? d.data.path : ""
      const rawContent = typeof d.data.content === "string" ? d.data.content : ""
      const normalizedPath = normalizeRoomFilePath(rawPath)
      if (!normalizedPath) continue
      const validated = validateRoomFileInput(normalizedPath, rawContent)
      if (!validated.ok) continue
      treeEntries.push({
        path: validated.path,
        mode: "100644",
        type: "blob",
        content: validated.content,
      })
    }

    if (treeEntries.length === 0) {
      return NextResponse.json(
        { error: "No valid text files were found in this room to push." },
        { status: 400 }
      )
    }

    const headers = githubAuthHeaders(pat)
    const repoSlug = `${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}`

    const repoRes = await fetch(`${GITHUB_API_BASE}/repos/${repoSlug}`, {
      headers,
      cache: "no-store",
    })
    if (repoRes.status === 401) {
      return NextResponse.json(
        { error: "Invalid GitHub personal access token." },
        { status: 401 }
      )
    }
    if (repoRes.status === 403 || repoRes.status === 404) {
      return NextResponse.json(
        {
          error:
            "Could not access the GitHub repository. Verify the URL and token permissions (Contents: Read & write).",
        },
        { status: 403 }
      )
    }
    if (!repoRes.ok) {
      return NextResponse.json(
        { error: "Could not verify the target GitHub repository." },
        { status: 502 }
      )
    }

    const refRes = await fetch(
      `${GITHUB_API_BASE}/repos/${repoSlug}/git/ref/heads/${encodeURIComponent(targetBranch)}`,
      { headers, cache: "no-store" }
    )
    if (refRes.status === 401) {
      return NextResponse.json(
        { error: "Invalid GitHub personal access token." },
        { status: 401 }
      )
    }
    if (refRes.status === 404) {
      return NextResponse.json(
        {
          error: `Branch "${targetBranch}" was not found in ${parsedRepo.owner}/${parsedRepo.repo}. Initialize the repository with an initial commit or choose an existing branch.`,
        },
        { status: 404 }
      )
    }
    if (!refRes.ok) {
      return NextResponse.json(
        { error: "Failed to read target branch reference from GitHub." },
        { status: 502 }
      )
    }

    const refJson = (await refRes.json()) as { object?: { sha?: string } }
    const baseCommitSha = refJson.object?.sha
    if (!baseCommitSha) {
      return NextResponse.json(
        { error: "Target branch reference is missing a commit SHA." },
        { status: 502 }
      )
    }

    const commitRes = await fetch(
      `${GITHUB_API_BASE}/repos/${repoSlug}/git/commits/${encodeURIComponent(baseCommitSha)}`,
      { headers, cache: "no-store" }
    )
    if (!commitRes.ok) {
      return NextResponse.json(
        { error: "Failed to inspect base commit tree on GitHub." },
        { status: 502 }
      )
    }
    const commitJson = (await commitRes.json()) as { tree?: { sha?: string } }
    const baseTreeSha = commitJson.tree?.sha
    if (!baseTreeSha) {
      return NextResponse.json(
        { error: "Base commit tree SHA missing from GitHub response." },
        { status: 502 }
      )
    }

    const createTreeRes = await fetch(`${GITHUB_API_BASE}/repos/${repoSlug}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeEntries,
      }),
      cache: "no-store",
    })
    if (createTreeRes.status === 401) {
      return NextResponse.json(
        { error: "Invalid GitHub personal access token." },
        { status: 401 }
      )
    }
    if (createTreeRes.status === 403 || createTreeRes.status === 404) {
      return NextResponse.json(
        {
          error:
            "GitHub denied tree creation. Make sure your token has Contents: Read & write permission on this repository.",
        },
        { status: 403 }
      )
    }
    if (!createTreeRes.ok) {
      return NextResponse.json(
        { error: "Failed to stage updated files in GitHub tree." },
        { status: 502 }
      )
    }
    const newTreeJson = (await createTreeRes.json()) as { sha?: string }
    const newTreeSha = newTreeJson.sha
    if (!newTreeSha) {
      return NextResponse.json(
        { error: "GitHub did not return a new tree SHA." },
        { status: 502 }
      )
    }

    const createCommitRes = await fetch(`${GITHUB_API_BASE}/repos/${repoSlug}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: `chore(cohort): sync room files from ${roomCode}`,
        tree: newTreeSha,
        parents: [baseCommitSha],
      }),
      cache: "no-store",
    })
    if (!createCommitRes.ok) {
      return NextResponse.json(
        { error: "Failed to create commit on GitHub." },
        { status: 502 }
      )
    }
    const newCommitJson = (await createCommitRes.json()) as { sha?: string; html_url?: string }
    const newCommitSha = newCommitJson.sha
    if (!newCommitSha) {
      return NextResponse.json(
        { error: "GitHub did not return a commit SHA." },
        { status: 502 }
      )
    }

    const updateRefRes = await fetch(
      `${GITHUB_API_BASE}/repos/${repoSlug}/git/refs/heads/${encodeURIComponent(targetBranch)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          sha: newCommitSha,
          force: false,
        }),
        cache: "no-store",
      }
    )
    if (updateRefRes.status === 403 || updateRefRes.status === 404) {
      return NextResponse.json(
        {
          error:
            "Could not update branch reference. Check branch protection rules and token Contents write permission.",
        },
        { status: 403 }
      )
    }
    if (updateRefRes.status === 422) {
      return NextResponse.json(
        {
          error:
            "Branch changed while pushing. Please try pushing again.",
        },
        { status: 409 }
      )
    }
    if (!updateRefRes.ok) {
      return NextResponse.json(
        { error: "Failed to update branch on GitHub." },
        { status: 502 }
      )
    }

    const commitUrl =
      newCommitJson.html_url ||
      `https://github.com/${parsedRepo.owner}/${parsedRepo.repo}/commit/${newCommitSha}`

    const logId = makeId("log")
    await fsCommit(
      [
        {
          type: "create",
          path: `rooms/${roomCode}/logs/${logId}`,
          data: {
            id: logId,
            actorId: user.uid,
            triggeredBy: user.uid,
            actor: user.displayName,
            action: "pushed to git",
            task_id: "files",
            note: `Pushed ${treeEntries.length} files to ${parsedRepo.owner}/${parsedRepo.repo}@${targetBranch}`.slice(
              0,
              500
            ),
          },
          serverTimestampFields: ["createdAt"],
        },
      ],
      user.idToken
    ).catch(() => {})

    return NextResponse.json({
      ok: true,
      commitUrl,
      commitSha: newCommitSha,
      filesCount: treeEntries.length,
      branch: targetBranch,
      repo: `${parsedRepo.owner}/${parsedRepo.repo}`,
    })
  } catch (error) {
    console.error("[/api/cohort/git/push] Request failed:", {
      name: error instanceof Error ? error.name : typeof error,
    })
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } }
      )
    }
    if (error instanceof AuthVerificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : "Failed to push files to Git"
    const lower = message.toLowerCase()
    const status =
      lower.includes("permission") || lower.includes("permission_denied") ? 403 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

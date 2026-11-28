import crypto from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import {
  AuthVerificationError,
  fsCommit,
  fsGetDocument,
  fsListCollection,
  verifyFirebaseIdToken,
  type CommitWriteOp,
} from "@/lib/server-firebase"
import { enforceUserRateLimit, RateLimitError } from "@/lib/rate-limit"
import {
  buildFileIdForPath,
  getFileNameFromPath,
  getMimeTypeForFile,
  isAllowedTextFilePath,
  MAX_FILE_SIZE_BYTES,
  MAX_ROOM_FILES,
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

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Cohort-AI-App",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

type GitTreeEntry = {
  path?: string
  type?: string
  sha?: string
  size?: number
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))
    await enforceUserRateLimit(user.uid, user.idToken, "cohort")

    const body = (await req.json().catch(() => ({}))) as {
      roomCode?: unknown
      repoUrl?: unknown
      branch?: unknown
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
            "Enter a valid public HTTPS GitHub repository URL (for example, https://github.com/owner/repo).",
        },
        { status: 400 }
      )
    }

    let requestedBranch = ""
    try {
      requestedBranch = normalizeGitBranch(body.branch, "")
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid branch name." },
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
    if (!memberData || (memberData.role !== "owner" && memberData.role !== "member")) {
      return NextResponse.json(
        { error: "Only approved room members can import files." },
        { status: 403 }
      )
    }

    const existingFileDocs = await fsListCollection(`rooms/${roomCode}/files`, user.idToken)
    const existingByPath = new Map<string, string>()
    for (const d of existingFileDocs) {
      const existingPath = typeof d.data.path === "string" ? d.data.path : ""
      if (existingPath) {
        existingByPath.set(existingPath.toLowerCase(), String(d.data.id || d.docId))
      }
    }

    const repoMetaRes = await fetch(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}`,
      { headers: githubHeaders(), cache: "no-store" }
    )
    if (repoMetaRes.status === 404 || repoMetaRes.status === 401) {
      return NextResponse.json(
        {
          error:
            "Repository not found or is private. Only public HTTPS GitHub repositories are supported for import.",
        },
        { status: 404 }
      )
    }
    if (repoMetaRes.status === 403 || repoMetaRes.status === 429) {
      return NextResponse.json(
        { error: "GitHub API rate limit exceeded or access denied. Please try again shortly." },
        { status: 429 }
      )
    }
    if (!repoMetaRes.ok) {
      return NextResponse.json(
        { error: "Could not read GitHub repository metadata." },
        { status: 502 }
      )
    }

    const repoMeta = (await repoMetaRes.json()) as {
      private?: boolean
      default_branch?: string
    }
    if (repoMeta.private) {
      return NextResponse.json(
        { error: "Private repositories are not supported for Git import yet." },
        { status: 403 }
      )
    }

    const targetBranch = requestedBranch || repoMeta.default_branch || "main"
    const treeRes = await fetch(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}/git/trees/${encodeURIComponent(targetBranch)}?recursive=1`,
      { headers: githubHeaders(), cache: "no-store" }
    )

    if (treeRes.status === 404) {
      return NextResponse.json(
        {
          error: `Branch "${targetBranch}" was not found in ${parsedRepo.owner}/${parsedRepo.repo}.`,
        },
        { status: 404 }
      )
    }
    if (treeRes.status === 403 || treeRes.status === 429) {
      return NextResponse.json(
        { error: "GitHub API rate limit exceeded. Please wait a moment and try again." },
        { status: 429 }
      )
    }
    if (!treeRes.ok) {
      return NextResponse.json(
        { error: "Failed to fetch repository file tree from GitHub." },
        { status: 502 }
      )
    }

    const treeJson = (await treeRes.json()) as {
      tree?: GitTreeEntry[]
      truncated?: boolean
    }
    const blobs = (treeJson.tree || []).filter((entry) => entry.type === "blob" && entry.path)

    let skippedCount = 0
    let remainingNewSlots = Math.max(0, MAX_ROOM_FILES - existingByPath.size)
    const candidates: Array<{ path: string; sha: string; existingDocId?: string }> = []

    for (const entry of blobs) {
      const normalizedPath = normalizeRoomFilePath(entry.path || "")
      if (!normalizedPath || !isAllowedTextFilePath(normalizedPath)) {
        skippedCount++
        continue
      }
      if (typeof entry.size === "number" && entry.size > MAX_FILE_SIZE_BYTES) {
        skippedCount++
        continue
      }
      if (!entry.sha) {
        skippedCount++
        continue
      }

      const existingDocId = existingByPath.get(normalizedPath.toLowerCase())
      if (existingDocId) {
        candidates.push({ path: normalizedPath, sha: entry.sha, existingDocId })
      } else if (remainingNewSlots > 0) {
        remainingNewSlots--
        candidates.push({ path: normalizedPath, sha: entry.sha })
      } else {
        skippedCount++
      }
    }

    if (candidates.length === 0) {
      const hasRoomCap = existingByPath.size >= MAX_ROOM_FILES
      return NextResponse.json(
        {
          error: hasRoomCap
            ? `This room already has ${MAX_ROOM_FILES} files (the maximum) and no matching files were updated. Delete some files before importing more.`
            : "No supported text files (.md, .txt, .json, .ts, .tsx, .js, .jsx, .css, .html, .py, .env.example under 200KB) were found to import.",
        },
        { status: 400 }
      )
    }

    const writes: CommitWriteOp[] = []
    let importedCount = 0
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5)
      const results = await Promise.all(
        batch.map(async (item) => {
          const blobRes = await fetch(
            `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}/git/blobs/${encodeURIComponent(item.sha)}`,
            { headers: githubHeaders(), cache: "no-store" }
          )
          if (!blobRes.ok) {
            return null
          }
          const blobData = (await blobRes.json()) as {
            content?: string
            encoding?: string
          }
          if (blobData.encoding !== "base64" || typeof blobData.content !== "string") {
            return null
          }
          const buffer = Buffer.from(blobData.content.replace(/\s+/g, ""), "base64")
          if (buffer.byteLength > MAX_FILE_SIZE_BYTES || buffer.includes(0)) {
            return null
          }
          let decoded: string
          try {
            decoded = utf8Decoder.decode(buffer)
          } catch {
            return null
          }
          const validated = validateRoomFileInput(item.path, decoded)
          if (!validated.ok) {
            return null
          }
          return {
            item,
            validated,
          }
        })
      )

      for (const result of results) {
        if (!result) {
          skippedCount++
          continue
        }
        const { item, validated } = result
        const fileId = item.existingDocId || buildFileIdForPath(validated.path)
        importedCount++

        if (item.existingDocId) {
          writes.push({
            type: "update",
            path: `rooms/${roomCode}/files/${fileId}`,
            data: {
              path: validated.path,
              name: getFileNameFromPath(validated.path),
              content: validated.content,
              mimeType: getMimeTypeForFile(validated.path),
              size: validated.size,
              updatedBy: user.uid,
            },
            updateMaskFields: ["path", "name", "content", "mimeType", "size", "updatedBy"],
            serverTimestampFields: ["updatedAt"],
          })
        } else {
          writes.push({
            type: "create",
            path: `rooms/${roomCode}/files/${fileId}`,
            data: {
              id: fileId,
              path: validated.path,
              name: getFileNameFromPath(validated.path),
              content: validated.content,
              mimeType: getMimeTypeForFile(validated.path),
              size: validated.size,
              createdBy: user.uid,
              updatedBy: user.uid,
            },
            serverTimestampFields: ["createdAt", "updatedAt"],
          })
        }
      }
    }

    if (writes.length === 0) {
      return NextResponse.json(
        { error: "All matching files exceeded the 200KB limit or contained binary data." },
        { status: 400 }
      )
    }

    const logId = makeId("log")
    writes.push({
      type: "create",
      path: `rooms/${roomCode}/logs/${logId}`,
      data: {
        id: logId,
        actorId: user.uid,
        triggeredBy: user.uid,
        actor: user.displayName,
        action: "imported files",
        task_id: "files",
        note: `Imported ${importedCount} files from ${parsedRepo.owner}/${parsedRepo.repo}@${targetBranch}`.slice(0, 500),
      },
      serverTimestampFields: ["createdAt"],
    })

    await fsCommit(writes, user.idToken)

    return NextResponse.json({
      ok: true,
      importedCount,
      skippedCount,
      totalFiles: Math.min(MAX_ROOM_FILES, existingByPath.size + importedCount),
      branch: targetBranch,
      repo: `${parsedRepo.owner}/${parsedRepo.repo}`,
    })
  } catch (error) {
    console.error("[/api/cohort/git/import] Request failed:", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
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
    const message = error instanceof Error ? error.message : "Failed to import from Git"
    const lower = message.toLowerCase()
    const status =
      lower.includes("permission") || lower.includes("permission_denied") ? 403 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

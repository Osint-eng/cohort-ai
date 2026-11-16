import crypto from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import {
  AuthVerificationError,
  FirestoreConflictError,
  fsCommit,
  verifyFirebaseIdToken,
} from "@/lib/server-firebase"
import { enforceUserRateLimit, RateLimitError } from "@/lib/rate-limit"

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function generateServerRoomCode(): string {
  const bytes = crypto.randomBytes(8)
  let code = ""
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return code
}

function buildDefaultRoomTitle(displayName: string): string {
  const firstName = displayName.trim().split(/\s+/)[0] || "Team"
  const shortDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date())
  return `${firstName}’s Project – ${shortDate}`.slice(0, 120)
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))
    await enforceUserRateLimit(user.uid, user.idToken, "room")

    const body = (await req.json().catch(() => ({}))) as { title?: unknown }
    const rawTitle = typeof body.title === "string" ? body.title.trim() : ""

    if (rawTitle.length > 0 && rawTitle.length < 3) {
      return NextResponse.json(
        { error: "Project title must be at least 3 characters, or leave it blank for an automatic title." },
        { status: 400 }
      )
    }

    const title = (rawTitle || buildDefaultRoomTitle(user.displayName)).slice(0, 120)
    const welcomeMsgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`

    // Atomic room creation: attempt create (currentDocument: { exists: false }) and retry on 409 collision
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateServerRoomCode()
      try {
        await fsCommit(
          [
            {
              type: "create",
              path: `rooms/${code}`,
              data: {
                code,
                title,
                summary: "Paste your project brief with @cohort extract to generate your team’s first-draft board.",
                ownerId: user.uid,
                nextTaskNumber: 1,
              },
              serverTimestampFields: ["createdAt", "updatedAt"],
            },
            {
              type: "create",
              path: `rooms/${code}/members/${user.uid}`,
              data: {
                uid: user.uid,
                displayName: user.displayName,
                photoURL: user.photoURL,
                role: "owner",
                online: true,
              },
              serverTimestampFields: ["joinedAt", "lastSeenAt"],
            },
            {
              type: "create",
              path: `rooms/${code}/messages/${welcomeMsgId}`,
              data: {
                id: welcomeMsgId,
                senderId: "cohort",
                triggeredBy: user.uid,
                senderName: "cohort",
                role: "assistant",
                text: `Welcome to ${title}! Paste a brief with "@cohort extract <brief>", run "@cohort check-in", or update tasks with "@cohort mark t1 complete".`,
              },
              serverTimestampFields: ["createdAt"],
            },
          ],
          user.idToken
        )

        return NextResponse.json({ code, title })
      } catch (err) {
        if (err instanceof FirestoreConflictError && attempt < 5) {
          continue
        }
        throw err
      }
    }

    return NextResponse.json(
      { error: "Could not allocate a unique room code. Please try again." },
      { status: 503 }
    )
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } }
      )
    }
    if (error instanceof AuthVerificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : "Failed to create room"
    const lower = message.toLowerCase()
    const status = lower.includes("token") || lower.includes("auth") ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

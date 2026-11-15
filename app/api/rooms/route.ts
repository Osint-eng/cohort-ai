import crypto from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { verifyFirebaseIdToken, fsGetDocument, fsCommit } from "@/lib/server-firebase"

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function generateServerRoomCode(): string {
  const bytes = crypto.randomBytes(8)
  let code = ""
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return code
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))
    const body = (await req.json().catch(() => ({}))) as { title?: unknown }
    const rawTitle = typeof body.title === "string" ? body.title.trim() : ""
    const title = (rawTitle || "Untitled project room").slice(0, 120)

    let code = ""
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = generateServerRoomCode()
      const existing = await fsGetDocument(`rooms/${candidate}`, user.idToken)
      if (!existing) {
        code = candidate
        break
      }
    }

    if (!code) {
      return NextResponse.json(
        { error: "Could not allocate a unique room code. Please try again." },
        { status: 503 }
      )
    }

    const welcomeMsgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`

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

    return NextResponse.json({ code })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create room"
    const status = message.toLowerCase().includes("token") || message.toLowerCase().includes("auth") ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

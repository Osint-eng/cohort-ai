import crypto from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import {
  verifyFirebaseIdToken,
  fsGetDocument,
  fsListCollection,
  fsCommit,
  type CommitWriteOp,
} from "@/lib/server-firebase"
import { extractBoardWithGemini, generateCheckInWithGemini } from "@/lib/gemini"

const ROOM_CODE_REGEX = /^[A-Z0-9]{8}$/

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

type TaskDoc = {
  id: string
  title: string
  suggested_owner: string
  owner_uid: string
  due_date: string
  status: "todo" | "in_progress" | "blocked" | "done"
  updatedBy: string
  createdAt?: string
  updatedAt?: string
}

type MemberDoc = {
  uid: string
  displayName: string
  photoURL?: string
  role?: string
  online?: boolean
}

function resolveMemberUid(
  suggestedOwner: string,
  members: MemberDoc[]
): string {
  const clean = suggestedOwner.replace(/^@/, "").trim().toLowerCase()
  if (!clean) return ""
  const exact = members.find((m) => m.displayName.toLowerCase() === clean)
  if (exact) return exact.uid
  const firstName = members.find(
    (m) => m.displayName.split(" ")[0].toLowerCase() === clean
  )
  return firstName ? firstName.uid : ""
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))
    const body = (await req.json().catch(() => ({}))) as {
      roomCode?: unknown
      messageText?: unknown
      brief?: unknown
      action?: unknown
    }

    const roomCode = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : ""
    if (!ROOM_CODE_REGEX.test(roomCode)) {
      return NextResponse.json({ error: "Invalid room code" }, { status: 400 })
    }

    const roomData = await fsGetDocument(`rooms/${roomCode}`, user.idToken)
    if (!roomData) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    const memberData = await fsGetDocument(`rooms/${roomCode}/members/${user.uid}`, user.idToken)
    if (!memberData) {
      return NextResponse.json({ error: "You are not a member of this room" }, { status: 403 })
    }

    const [taskDocs, memberDocs] = await Promise.all([
      fsListCollection(`rooms/${roomCode}/tasks`, user.idToken),
      fsListCollection(`rooms/${roomCode}/members`, user.idToken),
    ])

    const tasks: TaskDoc[] = taskDocs.map((d) => ({
      id: String(d.data.id || d.docId),
      title: String(d.data.title || ""),
      suggested_owner: String(d.data.suggested_owner || "@Team"),
      owner_uid: String(d.data.owner_uid || ""),
      due_date: String(d.data.due_date || "TBD"),
      status: (d.data.status as TaskDoc["status"]) || "todo",
      updatedBy: String(d.data.updatedBy || user.uid),
      createdAt: typeof d.data.createdAt === "string" ? d.data.createdAt : undefined,
      updatedAt: typeof d.data.updatedAt === "string" ? d.data.updatedAt : undefined,
    }))

    const members: MemberDoc[] = memberDocs.map((d) => ({
      uid: String(d.data.uid || d.docId),
      displayName: String(d.data.displayName || "Teammate"),
    }))

    const messageText = typeof body.messageText === "string" ? body.messageText.trim() : ""
    const action = typeof body.action === "string" ? body.action : ""
    const todayIso = new Date().toISOString().slice(0, 10)
    const roomTitle = String(roomData.title || "Project room")

    // 1. Extract board from brief (via modal action="extract" OR chat "@cohort extract <brief>")
    const extractMatch = messageText.match(/@cohort\s+extract(?:\s*[:\-]?\s*([\s\S]+))?$/i)
    if (action === "extract" || extractMatch) {
      const briefText =
        typeof body.brief === "string" && body.brief.trim()
          ? body.brief.trim()
          : extractMatch?.[1]?.trim() || ""

      if (!briefText) {
        const msgId = makeId("msg")
        await fsCommit(
          [
            {
              type: "create",
              path: `rooms/${roomCode}/messages/${msgId}`,
              data: {
                id: msgId,
                senderId: "cohort",
                triggeredBy: user.uid,
                senderName: "cohort",
                role: "assistant",
                text: "Paste your project brief right after @cohort extract (or use the Extract board button) and I’ll turn it into tasks, owners, and due dates.",
              },
              serverTimestampFields: ["createdAt"],
            },
          ],
          user.idToken
        )
        return NextResponse.json({ ok: true, promptForBrief: true })
      }

      const extracted = await extractBoardWithGemini({
        brief: briefText,
        members,
        existingTitle: roomTitle,
        todayIso,
      })

      // Delete existing tasks first if re-extracting so create rules apply cleanly
      if (taskDocs.length > 0) {
        await fsCommit(
          taskDocs.map((t) => ({
            type: "delete" as const,
            path: `rooms/${roomCode}/tasks/${t.docId}`,
          })),
          user.idToken
        )
      }

      const msgId = makeId("msg")
      const logId = makeId("log")
      const writes: CommitWriteOp[] = [
        {
          type: "update",
          path: `rooms/${roomCode}`,
          data: {
            summary: extracted.summary,
            nextTaskNumber: extracted.tasks.length + 1,
          },
          serverTimestampFields: ["updatedAt"],
          updateMaskFields: ["summary", "nextTaskNumber", "updatedAt"],
        },
        ...extracted.tasks.map((task) => ({
          type: "create" as const,
          path: `rooms/${roomCode}/tasks/${task.id}`,
          data: {
            id: task.id,
            title: task.title,
            suggested_owner: task.suggested_owner,
            owner_uid: resolveMemberUid(task.suggested_owner, members),
            due_date: task.due_date,
            status: task.status,
            updatedBy: user.uid,
          },
          serverTimestampFields: ["createdAt", "updatedAt"],
        })),
        {
          type: "create",
          path: `rooms/${roomCode}/messages/${msgId}`,
          data: {
            id: msgId,
            senderId: "cohort",
            triggeredBy: user.uid,
            senderName: "cohort",
            role: "assistant",
            text: `I extracted ${extracted.tasks.length} tasks from your brief (${extracted.tasks.map((t) => t.id).join(", ")}). Your team can update owners, mark tasks done, or flag blockers anytime.`,
          },
          serverTimestampFields: ["createdAt"],
        },
        {
          type: "create",
          path: `rooms/${roomCode}/logs/${logId}`,
          data: {
            id: logId,
            actorId: "cohort",
            triggeredBy: user.uid,
            actor: "cohort",
            action: "created",
            task_id: "board",
            note: `Extracted ${extracted.tasks.length} tasks from brief`,
          },
          serverTimestampFields: ["createdAt"],
        },
      ]

      await fsCommit(writes, user.idToken)
      return NextResponse.json({
        ok: true,
        summary: extracted.summary,
        tasks: extracted.tasks,
      })
    }

    // 2. Check-in command (@cohort check-in)
    if (/@cohort\s+check-?in\b/i.test(messageText)) {
      const checkInReply = await generateCheckInWithGemini({
        roomTitle,
        tasks,
        members,
        todayIso,
      })

      const msgId = makeId("msg")
      await fsCommit(
        [
          {
            type: "create",
            path: `rooms/${roomCode}/messages/${msgId}`,
            data: {
              id: msgId,
              senderId: "cohort",
              triggeredBy: user.uid,
              senderName: "cohort",
              role: "assistant",
              text: checkInReply,
            },
            serverTimestampFields: ["createdAt"],
          },
        ],
        user.idToken
      )
      return NextResponse.json({ ok: true })
    }

    // 3. Mark task command (@cohort mark t1 complete | @cohort mark t2 blocked because ...)
    const markMatch = messageText.match(
      /@cohort\s+mark\s+(t\d+)\s+(complete|completed|done|blocked|in[\s_-]?progress|started|todo|to[\s_-]?do)(?:\s+(?:because\s+|reason\s*:?\s*|:\s*|-\s*)?([\s\S]+))?$/i
    )
    if (markMatch) {
      const targetId = markMatch[1].toLowerCase()
      const rawState = markMatch[2].toLowerCase()
      const reason = (markMatch[3] || "").trim().replace(/^because\s+/i, "").slice(0, 480)

      const existingTask = tasks.find((t) => t.id.toLowerCase() === targetId)
      if (!existingTask) {
        const msgId = makeId("msg")
        await fsCommit(
          [
            {
              type: "create",
              path: `rooms/${roomCode}/messages/${msgId}`,
              data: {
                id: msgId,
                senderId: "cohort",
                triggeredBy: user.uid,
                senderName: "cohort",
                role: "assistant",
                text: `I couldn’t find task ${targetId} on the board. Current tasks: ${tasks.map((t) => t.id).join(", ") || "none yet"}.`,
              },
              serverTimestampFields: ["createdAt"],
            },
          ],
          user.idToken
        )
        return NextResponse.json({ ok: true })
      }

      let nextStatus: TaskDoc["status"] = "todo"
      let logAction = "updated"
      if (rawState === "complete" || rawState === "completed" || rawState === "done") {
        nextStatus = "done"
        logAction = "completed"
      } else if (rawState === "blocked") {
        nextStatus = "blocked"
        logAction = "blocked"
      } else if (rawState.includes("progress") || rawState === "started") {
        nextStatus = "in_progress"
        logAction = "started"
      } else {
        nextStatus = "todo"
        logAction = "moved to to do"
      }

      const logNote = (reason || existingTask.title).slice(0, 500)
      const msgId = makeId("msg")
      const logId = makeId("log")
      const replyText =
        nextStatus === "blocked" && reason
          ? `Marked ${existingTask.id} (${existingTask.title}) as blocked: "${reason}". Logged to activity.`
          : `Marked ${existingTask.id} (${existingTask.title}) as ${nextStatus.replace("_", " ")} and logged it to activity.`

      await fsCommit(
        [
          {
            type: "update",
            path: `rooms/${roomCode}/tasks/${existingTask.id}`,
            data: {
              status: nextStatus,
              updatedBy: user.uid,
            },
            serverTimestampFields: ["updatedAt"],
            updateMaskFields: ["status", "updatedBy", "updatedAt"],
          },
          {
            type: "create",
            path: `rooms/${roomCode}/logs/${logId}`,
            data: {
              id: logId,
              actorId: user.uid,
              triggeredBy: user.uid,
              actor: user.displayName,
              action: logAction,
              task_id: existingTask.id,
              note: logNote,
            },
            serverTimestampFields: ["createdAt"],
          },
          {
            type: "create",
            path: `rooms/${roomCode}/messages/${msgId}`,
            data: {
              id: msgId,
              senderId: "cohort",
              triggeredBy: user.uid,
              senderName: "cohort",
              role: "assistant",
              text: replyText,
            },
            serverTimestampFields: ["createdAt"],
          },
        ],
        user.idToken
      )
      return NextResponse.json({ ok: true })
    }

    // 4. List tasks (@cohort list)
    if (/@cohort\s+list\b/i.test(messageText)) {
      const replyText =
        tasks.length === 0
          ? "There are no tasks on the board yet. Try @cohort extract <your brief> to create some!"
          : `Here are the ${tasks.length} tasks on the board:\n` +
            tasks.map((t) => `• ${t.id}: ${t.title} (${t.suggested_owner}, ${t.status.replace("_", " ")}, due ${t.due_date})`).join("\n")

      const msgId = makeId("msg")
      await fsCommit(
        [
          {
            type: "create",
            path: `rooms/${roomCode}/messages/${msgId}`,
            data: {
              id: msgId,
              senderId: "cohort",
              triggeredBy: user.uid,
              senderName: "cohort",
              role: "assistant",
              text: replyText.slice(0, 7900),
            },
            serverTimestampFields: ["createdAt"],
          },
        ],
        user.idToken
      )
      return NextResponse.json({ ok: true })
    }

    // 5. Help or general @cohort mention
    const msgId = makeId("msg")
    await fsCommit(
      [
        {
          type: "create",
          path: `rooms/${roomCode}/messages/${msgId}`,
          data: {
            id: msgId,
            senderId: "cohort",
            triggeredBy: user.uid,
            senderName: "cohort",
            role: "assistant",
            text: 'Commands: "@cohort extract <brief>" to build a task board, "@cohort check-in" for an overdue/blocked summary, "@cohort mark t1 complete", "@cohort mark t2 blocked because <reason>", or "@cohort list".',
          },
          serverTimestampFields: ["createdAt"],
        },
      ],
      user.idToken
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cohort command failed"
    const lower = message.toLowerCase()
    const status =
      lower.includes("token") || lower.includes("auth")
        ? 401
        : lower.includes("not found")
          ? 404
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}

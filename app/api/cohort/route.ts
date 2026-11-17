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
import { extractBoardWithGemini, generateCheckInWithGemini } from "@/lib/gemini"

const ROOM_CODE_REGEX = /^[A-Z0-9]{8}$/
const MAX_TASKS_PER_ROOM = 40

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

async function setAgentStatus(
  roomCode: string,
  status: "watching" | "thinking",
  idToken: string
): Promise<void> {
  await fsCommit(
    [
      {
        type: "update",
        path: `rooms/${roomCode}`,
        data: { agentStatus: status },
        serverTimestampFields: ["agentStatusAt", "updatedAt"],
        updateMaskFields: ["agentStatus"],
      },
    ],
    idToken
  ).catch(() => {})
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))
    await enforceUserRateLimit(user.uid, user.idToken, "cohort")

    const body = (await req.json().catch(() => ({}))) as {
      roomCode?: unknown
      messageText?: unknown
      brief?: unknown
      action?: unknown
      extractMode?: unknown
      replaceConfirmed?: unknown
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
    if (memberData.role !== "owner" && memberData.role !== "member") {
      return NextResponse.json(
        { error: "Your join request is waiting for the room owner’s approval." },
        { status: 403 }
      )
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

    const members: MemberDoc[] = memberDocs
      .filter((d) => d.data.role !== "pending")
      .map((d) => ({
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

      const requestedMode = body.extractMode === "replace" ? "replace" : "merge"
      const replaceConfirmed = body.replaceConfirmed === true
      const hasExistingTasks = tasks.length > 0

      if (hasExistingTasks && requestedMode === "replace" && !replaceConfirmed) {
        return NextResponse.json(
          {
            error: "Please confirm replacing existing board tasks, or choose merge mode to keep current progress.",
            requiresConfirmation: true,
          },
          { status: 409 }
        )
      }

      const isReplace = !hasExistingTasks || (requestedMode === "replace" && replaceConfirmed)
      const maxExistingNum = tasks.reduce((max, t) => {
        const num = Number(t.id.replace(/^t/i, "")) || 0
        return Math.max(max, num)
      }, 0)
      const roomNextNum = typeof roomData.nextTaskNumber === "number" ? roomData.nextTaskNumber : 1
      const startTaskNumber = isReplace ? 1 : Math.max(roomNextNum, maxExistingNum + 1)

      if (!isReplace && tasks.length >= MAX_TASKS_PER_ROOM) {
        return NextResponse.json(
          { error: `This board already has ${MAX_TASKS_PER_ROOM} tasks. Mark or clean up tasks, or choose Replace board.` },
          { status: 400 }
        )
      }

      const remainingCapacity = isReplace
        ? 8
        : Math.max(1, Math.min(8, MAX_TASKS_PER_ROOM - tasks.length))

      let extracted
      await setAgentStatus(roomCode, "thinking", user.idToken)
      try {
        extracted = await extractBoardWithGemini({
          brief: briefText,
          members,
          existingTitle: roomTitle,
          todayIso,
          startTaskNumber,
          maxTasks: remainingCapacity,
          existingTasks: isReplace
            ? undefined
            : tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        })
      } catch (err) {
        await setAgentStatus(roomCode, "watching", user.idToken)
        throw err
      }

      if (isReplace && taskDocs.length > 0) {
        await fsCommit(
          taskDocs.map((t) => ({
            type: "delete" as const,
            path: `rooms/${roomCode}/tasks/${t.docId}`,
          })),
          user.idToken
        )
      }

      const nextTaskNumber = Math.min(200, startTaskNumber + extracted.tasks.length)
      const msgId = makeId("msg")
      const logId = makeId("log")
      const actionVerb = isReplace && hasExistingTasks ? "replaced" : "added"
      const writes: CommitWriteOp[] = [
        {
          type: "update",
          path: `rooms/${roomCode}`,
          data: {
            summary: extracted.summary,
            nextTaskNumber,
            agentStatus: "watching",
          },
          serverTimestampFields: ["updatedAt", "agentStatusAt"],
          updateMaskFields: ["summary", "nextTaskNumber", "agentStatus"],
        },
        ...extracted.tasks.map((task) => ({
          type: "create" as const,
          path: `rooms/${roomCode}/tasks/${task.id}`,
          data: {
            id: task.id,
            title: task.title,
            ...(task.description ? { description: task.description } : {}),
            task_type: task.task_type,
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
            text: isReplace
              ? `I extracted ${extracted.tasks.length} tasks from your brief (${extracted.tasks.map((t) => t.id).join(", ")}). Your team can update owners, mark tasks done, or flag blockers anytime.`
              : `I added ${extracted.tasks.length} new tasks to your board (${extracted.tasks.map((t) => t.id).join(", ")}) while preserving your existing ${tasks.length} tasks.`,
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
            action: actionVerb === "replaced" ? "updated" : "created",
            task_id: "board",
            note: isReplace
              ? `Extracted ${extracted.tasks.length} tasks from brief`
              : `Merged ${extracted.tasks.length} new tasks into board`,
          },
          serverTimestampFields: ["createdAt"],
        },
      ]

      await fsCommit(writes, user.idToken)
      return NextResponse.json({
        ok: true,
        mode: isReplace ? "replace" : "merge",
        summary: extracted.summary,
        tasks: extracted.tasks,
      })
    }

    // 2. Check-in command (@cohort check-in)
    if (/@cohort\s+check-?in\b/i.test(messageText)) {
      let checkInReply: string
      await setAgentStatus(roomCode, "thinking", user.idToken)
      try {
        checkInReply = await generateCheckInWithGemini({
          roomTitle,
          tasks,
          members,
          todayIso,
        })
      } catch (err) {
        await setAgentStatus(roomCode, "watching", user.idToken)
        throw err
      }

      const msgId = makeId("msg")
      await fsCommit(
        [
          {
            type: "update",
            path: `rooms/${roomCode}`,
            data: { agentStatus: "watching" },
            serverTimestampFields: ["agentStatusAt", "updatedAt"],
            updateMaskFields: ["agentStatus"],
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
            updateMaskFields: ["status", "updatedBy"],
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
            text: 'Commands: "@cohort extract <brief>" to add tasks to your board, "@cohort check-in" for an overdue/blocked summary, "@cohort mark t1 complete", "@cohort mark t2 blocked because <reason>", or "@cohort list".',
          },
          serverTimestampFields: ["createdAt"],
        },
      ],
      user.idToken
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[/api/cohort] Request failed:", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
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
    const message = error instanceof Error ? error.message : "Cohort command failed"
    const lower = message.toLowerCase()
    const status =
      lower.includes("token") || lower.includes("auth")
        ? 401
        : lower.includes("permission") || lower.includes("permission_denied")
          ? 403
          : lower.includes("not found")
            ? 404
            : 500
    return NextResponse.json({ error: message }, { status })
  }
}

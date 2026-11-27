import { NextRequest, NextResponse } from "next/server"
import {
  AuthVerificationError,
  fsGetDocument,
  verifyFirebaseIdToken,
} from "@/lib/server-firebase"
import { enforceUserRateLimit, RateLimitError } from "@/lib/rate-limit"
import {
  GeminiBadOutputError,
  GeminiQuotaError,
  generateSandboxStarterWithGemini,
} from "@/lib/gemini"
import {
  buildStarterFilesForTask,
  detectTaskType,
  type SandboxTemplateMode,
} from "@/lib/task-sandbox"

const ROOM_CODE_REGEX = /^[A-Z0-9]{8}$/
const TASK_ID_REGEX = /^t[0-9]+$/
const VALID_TEMPLATES = new Set<SandboxTemplateMode>([
  "react",
  "vanilla",
  "backend",
  "design",
  "research",
])

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))
    await enforceUserRateLimit(user.uid, user.idToken, "cohort")

    const body = (await req.json().catch(() => ({}))) as {
      roomCode?: unknown
      taskId?: unknown
      templateMode?: unknown
    }

    const roomCode = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : ""
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : ""
    const rawTemplate =
      typeof body.templateMode === "string" ? body.templateMode.trim().toLowerCase() : ""

    if (!ROOM_CODE_REGEX.test(roomCode)) {
      return NextResponse.json({ error: "Invalid room code" }, { status: 400 })
    }
    if (!TASK_ID_REGEX.test(taskId)) {
      return NextResponse.json({ error: "Invalid task ID" }, { status: 400 })
    }

    const [roomData, memberData, taskData] = await Promise.all([
      fsGetDocument(`rooms/${roomCode}`, user.idToken),
      fsGetDocument(`rooms/${roomCode}/members/${user.uid}`, user.idToken),
      fsGetDocument(`rooms/${roomCode}/tasks/${taskId}`, user.idToken),
    ])

    if (!roomData) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }
    if (!memberData || (memberData.role !== "owner" && memberData.role !== "member")) {
      return NextResponse.json(
        { error: "Only approved room members can generate task starters." },
        { status: 403 }
      )
    }
    if (!taskData) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 })
    }

    const title = String(taskData.title || `Task ${taskId}`)
    const description =
      typeof taskData.description === "string" ? taskData.description : ""
    const taskType = detectTaskType(title, description, taskData.task_type)
    const owner = String(taskData.suggested_owner || "@Team")
    const dueDate = String(taskData.due_date || "TBD")
    const status = (
      ["todo", "in_progress", "blocked", "done"].includes(String(taskData.status))
        ? String(taskData.status)
        : "todo"
    ) as "todo" | "in_progress" | "blocked" | "done"

    const roomTitle = String(roomData.title || "Project room")
    const projectSummary = String(roomData.summary || "")

    const baseStarter = buildStarterFilesForTask(
      {
        id: taskId,
        title,
        description,
        task_type: taskType,
        suggested_owner: owner,
        due_date: dueDate,
        status,
      },
      roomTitle,
      projectSummary,
      VALID_TEMPLATES.has(rawTemplate as SandboxTemplateMode)
        ? (rawTemplate as SandboxTemplateMode)
        : undefined
    )

    const generatedFiles = await generateSandboxStarterWithGemini({
      roomTitle,
      projectSummary,
      taskId,
      taskTitle: title,
      taskDescription: description,
      taskType,
      templateMode: baseStarter.templateMode,
      owner,
      dueDate,
    })

    return NextResponse.json({
      ok: true,
      templateMode: baseStarter.templateMode,
      files: {
        ...baseStarter.files,
        ...generatedFiles,
      },
    })
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } }
      )
    }
    if (error instanceof GeminiQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 429 })
    }
    if (error instanceof GeminiBadOutputError) {
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    if (error instanceof AuthVerificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : "Could not generate starter code"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

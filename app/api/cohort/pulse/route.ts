import crypto from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import {
  AuthVerificationError,
  FirestoreConflictError,
  fsCommit,
  fsGetDocument,
  fsGetDocumentWithMeta,
  fsListCollection,
  fsRunQuery,
  verifyFirebaseIdToken,
} from "@/lib/server-firebase"
import { enforceUserRateLimit, RateLimitError } from "@/lib/rate-limit"
import {
  GeminiBadOutputError,
  GeminiQuotaError,
  generateProactiveNudgeWithGemini,
} from "@/lib/gemini"
import {
  buildNextNudgeState,
  evaluateProactiveNudge,
  getLocalTodayIso,
  isWithinPulseCheckThrottle,
  normalizeAggressiveness,
  normalizeTzOffsetMinutes,
  parseNudgeState,
  PROACTIVE_THRESHOLDS,
} from "@/lib/proactive-cohort"

const ROOM_CODE_REGEX = /^[A-Z0-9]{8}$/

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseIdToken(req.headers.get("authorization"))

    const body = (await req.json().catch(() => ({}))) as {
      roomCode?: unknown
      tzOffsetMinutes?: unknown
    }
    const tzOffsetMinutes = normalizeTzOffsetMinutes(body.tzOffsetMinutes)
    const roomCode = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : ""
    if (!ROOM_CODE_REGEX.test(roomCode)) {
      return NextResponse.json({ error: "Invalid room code" }, { status: 400 })
    }

    const [roomWithMeta, memberData] = await Promise.all([
      fsGetDocumentWithMeta(`rooms/${roomCode}`, user.idToken),
      fsGetDocument(`rooms/${roomCode}/members/${user.uid}`, user.idToken),
    ])

    if (!roomWithMeta) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }
    if (!memberData || (memberData.role !== "owner" && memberData.role !== "member")) {
      return NextResponse.json({ error: "Only approved room members can run @cohort pulse." }, { status: 403 })
    }

    const roomData = roomWithMeta.data
    const aggressiveness = normalizeAggressiveness(roomData.agentAggressiveness)
    const nowMs = Date.now()
    const lastProactiveAtIso =
      typeof roomData.lastProactiveAt === "string" ? roomData.lastProactiveAt : undefined
    const lastPulseCheckAtIso =
      typeof roomData.lastPulseCheckAt === "string" ? roomData.lastPulseCheckAt : undefined

    if (lastProactiveAtIso) {
      const lastProactiveMs = Date.parse(lastProactiveAtIso)
      if (
        !Number.isNaN(lastProactiveMs) &&
        nowMs - lastProactiveMs < PROACTIVE_THRESHOLDS[aggressiveness].cooldownMs
      ) {
        return NextResponse.json({ ok: true, nudged: false })
      }
    }

    if (isWithinPulseCheckThrottle(aggressiveness, lastPulseCheckAtIso, nowMs)) {
      return NextResponse.json({ ok: true, nudged: false })
    }

    const taskDocs = await fsListCollection(`rooms/${roomCode}/tasks`, user.idToken)

    const tasks = taskDocs.map((d) => ({
      id: String(d.data.id || d.docId),
      title: String(d.data.title || ""),
      suggested_owner: String(d.data.suggested_owner || "@Team"),
      due_date: String(d.data.due_date || "TBD"),
      status: (d.data.status as "todo" | "in_progress" | "blocked" | "done") || "todo",
      updatedAt: typeof d.data.updatedAt === "string" ? d.data.updatedAt : undefined,
    }))

    const nudgeState = parseNudgeState(roomData.nudgeState)
    const hasOpenTasks = tasks.some((t) => t.status !== "done")

    // First evaluate task-only triggers (stale_blocked, deadline_soon) without reading messages.
    // Only fetch the latest message for idle detection when open tasks exist and no task trigger fired.
    let evaluation = hasOpenTasks
      ? evaluateProactiveNudge({
          aggressiveness,
          lastProactiveAtIso,
          roomCreatedAtIso: typeof roomData.createdAt === "string" ? roomData.createdAt : undefined,
          nudgeState,
          tasks,
          messages: [],
          nowMs,
          tzOffsetMinutes,
        })
      : { shouldNudge: false as const }

    if (hasOpenTasks && evaluation.reason !== "stale_blocked" && evaluation.reason !== "deadline_soon") {
      const messageDocs = await fsRunQuery(
        {
          parentPath: `rooms/${roomCode}`,
          collectionId: "messages",
          orderBy: [{ fieldPath: "createdAt", direction: "DESCENDING" }],
          limit: 1,
        },
        user.idToken
      )
      const messages = messageDocs.map((d) => ({
        role: String(d.data.role || "user"),
        senderId: String(d.data.senderId || ""),
        createdAt: typeof d.data.createdAt === "string" ? d.data.createdAt : undefined,
      }))
      evaluation = evaluateProactiveNudge({
        aggressiveness,
        lastProactiveAtIso,
        roomCreatedAtIso: typeof roomData.createdAt === "string" ? roomData.createdAt : undefined,
        nudgeState,
        tasks,
        messages,
        nowMs,
        tzOffsetMinutes,
      })
    }

    const currentAgentStatus = roomData.agentStatus === "thinking" ? "thinking" : "watching"

    if (!evaluation.shouldNudge || !evaluation.reason || !evaluation.summaryContext) {
      const prunedNudgeState = buildNextNudgeState({
        currentState: nudgeState,
        tasks,
        nowMs,
      })
      const hasStaleNudgeEntries =
        Object.keys(prunedNudgeState).length < Object.keys(nudgeState).length
      const checkUpdateData: Record<string, unknown> = { agentStatus: currentAgentStatus }
      const checkUpdateMask = ["agentStatus"]
      if (hasStaleNudgeEntries) {
        checkUpdateData.nudgeState = prunedNudgeState
        checkUpdateMask.push("nudgeState")
      }
      try {
        await fsCommit(
          [
            {
              type: "update",
              path: `rooms/${roomCode}`,
              data: checkUpdateData,
              serverTimestampFields: ["lastPulseCheckAt", "updatedAt"],
              updateMaskFields: checkUpdateMask,
              ifMatchUpdateTime: roomWithMeta.updateTime,
            },
          ],
          user.idToken
        )
      } catch (err) {
        if (err instanceof FirestoreConflictError) {
          return NextResponse.json({ ok: true, nudged: false })
        }
        throw err
      }
      return NextResponse.json({ ok: true, nudged: false })
    }

    // Only enforce LLM rate limit and read members when a proactive check actually requires Gemini generation
    await enforceUserRateLimit(user.uid, user.idToken, "cohort")
    const memberDocs = await fsListCollection(`rooms/${roomCode}/members`, user.idToken)
    const members = memberDocs
      .filter((d) => d.data.role !== "pending")
      .map((d) => ({
        uid: String(d.data.uid || d.docId),
        displayName: String(d.data.displayName || "Teammate"),
      }))

    const todayIso = getLocalTodayIso(nowMs, tzOffsetMinutes)
    const roomTitle = String(roomData.title || "Project room")
    const nudgeText = await generateProactiveNudgeWithGemini({
      roomTitle,
      reason: evaluation.reason,
      summaryContext: evaluation.summaryContext,
      tasks,
      members,
      todayIso,
    })

    const msgId = makeId("msg")
    const logId = makeId("log")
    const reasonLabel =
      evaluation.reason === "stale_blocked"
        ? "Proactive check on stale blocker"
        : evaluation.reason === "deadline_soon"
          ? "Proactive check on upcoming deadline"
          : "Proactive check-in after quiet period"

    const nextNudgeState = buildNextNudgeState({
      currentState: nudgeState,
      tasks,
      nudgedTaskId: evaluation.targetTaskId,
      nowMs,
    })

    try {
      await fsCommit(
        [
          {
            type: "update",
            path: `rooms/${roomCode}`,
            data: {
              agentStatus: "watching",
              nudgeState: nextNudgeState,
            },
            serverTimestampFields: ["lastProactiveAt", "lastPulseCheckAt", "agentStatusAt", "updatedAt"],
            updateMaskFields: ["agentStatus", "nudgeState"],
            ifMatchUpdateTime: roomWithMeta.updateTime,
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
              text: nudgeText,
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
              action: "checked in",
              task_id: evaluation.targetTaskId || "board",
              note: reasonLabel.slice(0, 500),
            },
            serverTimestampFields: ["createdAt"],
          },
        ],
        user.idToken
      )
    } catch (err) {
      // Another active teammate's tab won the race; treat cleanly as a non-duplicate no-op
      if (err instanceof FirestoreConflictError) {
        return NextResponse.json({ ok: true, nudged: false })
      }
      throw err
    }

    return NextResponse.json({ ok: true, nudged: true, reason: evaluation.reason })
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
    const message = error instanceof Error ? error.message : "Proactive pulse failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

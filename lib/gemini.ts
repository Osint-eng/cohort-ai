import {
  ApiError,
  GoogleGenAI,
  Type,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from "@google/genai"
import {
  detectTaskType,
  type SandboxFiles,
  type SandboxTemplateMode,
  type TaskType,
} from "./task-sandbox"

const MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-4-hydrogen"
export const GEMINI_TIMEOUT_MS = 25_000
export const GEMINI_TOTAL_BUDGET_MS = 40_000
export const GEMINI_MIN_REMAINING_BUDGET_MS = 5_000
export const GEMINI_MAX_RETRIES = 2
export const GEMINI_BASE_BACKOFF_MS = 500
export const GEMINI_MAX_JITTER_MS = 250

export type GeminiCallDeps = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  randomJitterMs?: () => number
}

export function computeGeminiRetryDelayMs(retryAttempt: number, jitterMs: number): number {
  const safeAttempt = Math.max(0, Math.floor(retryAttempt))
  const safeJitter = Math.max(0, Math.min(GEMINI_MAX_JITTER_MS, Math.floor(jitterMs)))
  return GEMINI_BASE_BACKOFF_MS * 2 ** safeAttempt + safeJitter
}

export function computeGeminiAttemptTimeoutMs(elapsedMs: number): number {
  const remaining = Math.max(0, GEMINI_TOTAL_BUDGET_MS - Math.max(0, elapsedMs))
  return Math.min(GEMINI_TIMEOUT_MS, remaining)
}

export class GeminiQuotaError extends Error {
  constructor(
    message = "@cohort hit Gemini's rate limit right now. Please wait a moment and try again."
  ) {
    super(message)
    this.name = "GeminiQuotaError"
  }
}

export class GeminiBadOutputError extends Error {
  constructor(
    message = "@cohort received an invalid or incomplete response from Gemini. Please try again."
  ) {
    super(message)
    this.name = "GeminiBadOutputError"
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.")
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  })
}

function getGeminiErrorStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) {
    return error.status
  }
  if (error && typeof error === "object") {
    const rec = error as { status?: unknown; statusCode?: unknown; code?: unknown }
    if (typeof rec.status === "number") return rec.status
    if (typeof rec.statusCode === "number") return rec.statusCode
    if (typeof rec.code === "number") return rec.code
  }
  const msg = error instanceof Error ? error.message : String(error)
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(msg)) return 429
  if (/\b503\b|UNAVAILABLE/i.test(msg)) return 503
  return undefined
}

export async function callGenerateContent(params: {
  contents: string
  config?: GenerateContentConfig
  maxOutputTokens: number
  deps?: GeminiCallDeps
}): Promise<GenerateContentResponse> {
  const ai = getGeminiClient()
  const now = params.deps?.now ?? Date.now
  const sleep =
    params.deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const randomJitterMs =
    params.deps?.randomJitterMs ??
    (() => Math.floor(Math.random() * GEMINI_MAX_JITTER_MS))

  const startMs = now()

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    const elapsedMs = Math.max(0, now() - startMs)
    const attemptTimeoutMs = computeGeminiAttemptTimeoutMs(elapsedMs)
    if (attemptTimeoutMs <= 0) {
      throw new GeminiBadOutputError(
        "@cohort took too long to hear back from Gemini. Please try again."
      )
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new Error("Gemini request timed out"))
    }, attemptTimeoutMs)

    try {
      return await ai.models.generateContent({
        model: MODEL,
        contents: params.contents,
        config: {
          ...params.config,
          maxOutputTokens: params.maxOutputTokens,
          abortSignal: controller.signal,
        },
      })
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new GeminiBadOutputError(
          "@cohort took too long to hear back from Gemini. Please try again."
        )
      }
      const status = getGeminiErrorStatus(error)
      if ((status === 429 || status === 503) && attempt < GEMINI_MAX_RETRIES) {
        const elapsedAfterAttempt = Math.max(0, now() - startMs)
        const remainingBudgetMs = GEMINI_TOTAL_BUDGET_MS - elapsedAfterAttempt
        const delayMs = computeGeminiRetryDelayMs(attempt, randomJitterMs())
        if (
          remainingBudgetMs >= GEMINI_MIN_REMAINING_BUDGET_MS &&
          remainingBudgetMs - delayMs >= GEMINI_MIN_REMAINING_BUDGET_MS
        ) {
          await sleep(delayMs)
          continue
        }
      }
      if (status === 429) {
        throw new GeminiQuotaError()
      }
      if (status === 503 || (typeof status === "number" && status >= 500)) {
        throw new GeminiBadOutputError(
          "Gemini is temporarily unavailable. Please try again in a moment."
        )
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  throw new GeminiBadOutputError()
}

export type ExtractedTask = {
  id: string
  title: string
  description: string
  task_type: TaskType
  weight: 1 | 2 | 3
  suggested_owner: string
  owner_uid: string
  due_date: string
  status: "todo" | "in_progress" | "blocked" | "done"
}

export type ExtractedBoardResult = {
  summary: string
  tasks: ExtractedTask[]
}

const VALID_STATUSES = new Set(["todo", "in_progress", "blocked", "done"])

function buildUniqueMemberHandles(
  members: Array<{ uid: string; displayName: string }>
): Array<{ uid: string; handle: string }> {
  const firstNameCounts = new Map<string, number>()
  const parsed = members.map((m) => {
    const parts = m.displayName.trim().split(/\s+/).filter(Boolean)
    const first = parts[0] || "Member"
    const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] || "" : ""
    const key = first.toLowerCase()
    firstNameCounts.set(key, (firstNameCounts.get(key) || 0) + 1)
    return { uid: m.uid, first, lastInitial, key }
  })

  const usedHandles = new Set<string>(["@unassigned"])
  return parsed.map(({ uid, first, lastInitial, key }) => {
    const hasDuplicateFirst = (firstNameCounts.get(key) || 0) > 1
    const base =
      hasDuplicateFirst && lastInitial
        ? `@${first}${lastInitial.toUpperCase()}`
        : `@${first}`
    const truncatedBase = base.slice(0, 76)
    let candidate = truncatedBase
    let suffix = 2
    while (usedHandles.has(candidate.toLowerCase())) {
      candidate = `${truncatedBase}${suffix}`.slice(0, 80)
      suffix += 1
    }
    usedHandles.add(candidate.toLowerCase())
    return { uid, handle: candidate }
  })
}

export async function extractBoardWithGemini(input: {
  brief: string
  members: Array<{ uid: string; displayName: string }>
  existingTitle: string
  todayIso: string
  startTaskNumber?: number
  maxTasks?: number
  existingTasks?: Array<{ id: string; title: string; status: string }>
}): Promise<ExtractedBoardResult> {
  const startNumber = Math.max(1, input.startTaskNumber ?? 1)
  const maxTasks = Math.max(1, Math.min(12, input.maxTasks ?? 8))
  const memberDirectory = buildUniqueMemberHandles(input.members)
  const suggestedOwnerEnum = Array.from(
    new Set([...memberDirectory.map((m) => m.handle), "@Unassigned"])
  )
  const ownerUidEnum = Array.from(new Set([...memberDirectory.map((m) => m.uid), ""]))
  const validUidSet = new Set(ownerUidEnum)
  const validHandleSet = new Set(suggestedOwnerEnum)
  const handleByUid = new Map(memberDirectory.map((m) => [m.uid, m.handle]))

  const existingContext =
    input.existingTasks && input.existingTasks.length > 0
      ? [
          "Existing tasks already on the board (DO NOT duplicate these; extract only genuinely new tasks):",
          ...input.existingTasks.map((t) => `- ${t.id}: ${t.title} [${t.status}]`),
          "",
        ]
      : []

  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Project room title: ${input.existingTitle}.`,
    `Team members available (JSON {uid, handle}): ${
      memberDirectory.length > 0 ? JSON.stringify(memberDirectory) : "None"
    }.`,
    ...existingContext,
    `Project brief:\n${input.brief.trim().slice(0, 6000)}`,
    "",
    `Extract a crisp 1-sentence project summary and 1 to ${maxTasks} concrete, actionable tasks for this student team.`,
    `Use sequential IDs starting at t${startNumber} (t${startNumber}, t${startNumber + 1}...) and distribute tasks across the available team members when reasonable.`,
    "For each task, set suggested_owner to a member's exact handle (or '@Unassigned') and set owner_uid to that member's exact uid (or '' if '@Unassigned').",
    "Format due_date strictly as ISO YYYY-MM-DD (e.g. '2026-11-28') using dates from the brief or realistic milestones after today, or 'TBD' if no date applies.",
    "For each task, include a crisp 1-sentence description (acceptance criteria/scope, max 220 chars), classify task_type as one of: frontend, backend, design, research, general, and assign an integer effort weight from 1 (small/quick) to 3 (large/complex).",
    "Set status to 'todo' unless the brief explicitly says a task is already in progress, blocked, or done.",
  ].join("\n")

  const response = await callGenerateContent({
    contents: prompt,
    maxOutputTokens: 4000,
    config: {
      systemInstruction:
        "You are Cohort, an AI project manager for student group projects. Turn pasted project briefs into clear, balanced, actionable task boards in strict JSON.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: "One concise sentence summarizing the project goal.",
          },
          tasks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: {
                  type: Type.STRING,
                  description: `Sequential task ID starting from t${startNumber}.`,
                },
                title: {
                  type: Type.STRING,
                  description: "Short, specific, actionable task title.",
                },
                description: {
                  type: Type.STRING,
                  description: "Concise 1-sentence acceptance criteria or implementation detail.",
                },
                task_type: {
                  type: Type.STRING,
                  description: "One of: frontend, backend, design, research, general.",
                },
                weight: {
                  type: Type.INTEGER,
                  minimum: 1,
                  maximum: 3,
                  description: "Effort weight integer from 1 (small) to 3 (large).",
                },
                suggested_owner: {
                  type: Type.STRING,
                  enum: suggestedOwnerEnum,
                  description: "Owner handle from the team member list, or '@Unassigned'.",
                },
                owner_uid: {
                  type: Type.STRING,
                  enum: ownerUidEnum,
                  description: "Matching uid of the assigned member, or '' if unassigned.",
                },
                due_date: {
                  type: Type.STRING,
                  description: "Due date strictly in YYYY-MM-DD format (or 'TBD' if unknown).",
                },
                status: {
                  type: Type.STRING,
                  description: "One of: todo, in_progress, blocked, done.",
                },
              },
              required: [
                "id",
                "title",
                "description",
                "task_type",
                "weight",
                "suggested_owner",
                "owner_uid",
                "due_date",
                "status",
              ],
            },
          },
        },
        required: ["summary", "tasks"],
      },
    },
  })

  const rawText = (response.text ?? "").trim()
  if (!rawText) {
    throw new GeminiBadOutputError("Gemini returned an empty response while extracting the board.")
  }

  let parsed: {
    summary?: unknown
    tasks?: Array<Partial<ExtractedTask>>
  }
  try {
    parsed = JSON.parse(rawText) as {
      summary?: unknown
      tasks?: Array<Partial<ExtractedTask>>
    }
  } catch {
    throw new GeminiBadOutputError(
      "Gemini returned malformed task board JSON. Please try again."
    )
  }

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
  const tasks: ExtractedTask[] = rawTasks.slice(0, maxTasks).map((t, index) => {
    const id = `t${startNumber + index}`
    const title = String(t.title || `Task ${startNumber + index}`).trim().slice(0, 200) || `Task ${startNumber + index}`
    const description = String(t.description || "").trim().slice(0, 500)
    const task_type = detectTaskType(title, description, t.task_type)
    const rawOwnerUid = typeof t.owner_uid === "string" ? t.owner_uid.trim() : ""
    const owner_uid = validUidSet.has(rawOwnerUid) ? rawOwnerUid : ""
    let owner = String(t.suggested_owner || "@Unassigned").trim()
    if (owner_uid && (!validHandleSet.has(owner) || owner === "@Unassigned")) {
      owner = handleByUid.get(owner_uid) || "@Unassigned"
    } else if (!validHandleSet.has(owner)) {
      if (!owner.startsWith("@")) owner = `@${owner}`
    }
    owner = owner.slice(0, 80) || "@Unassigned"
    const rawDueDate = typeof t.due_date === "string" ? t.due_date.trim() : ""
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDueDate) ? rawDueDate : "TBD"
    const rawStatus = String(t.status || "todo").trim()
    const status = (VALID_STATUSES.has(rawStatus) ? rawStatus : "todo") as ExtractedTask["status"]
    const rawWeight =
      typeof t.weight === "number" ? Math.round(t.weight) : Math.round(Number(t.weight))
    const weight: 1 | 2 | 3 =
      Number.isFinite(rawWeight) && rawWeight >= 3
        ? 3
        : Number.isFinite(rawWeight) && rawWeight === 2
          ? 2
          : 1
    return {
      id,
      title,
      description,
      task_type,
      weight,
      suggested_owner: owner,
      owner_uid,
      due_date: dueDate,
      status,
    }
  })

  if (tasks.length === 0) {
    throw new GeminiBadOutputError("Gemini did not return any tasks for that brief.")
  }

  const summary =
    String(parsed.summary || "").trim().slice(0, 600) ||
    `Shared plan for ${input.existingTitle}.`

  return { summary, tasks }
}

export async function generateCheckInWithGemini(input: {
  roomTitle: string
  tasks: Array<{
    id: string
    title: string
    suggested_owner: string
    due_date: string
    status: string
  }>
  members: Array<{ displayName: string }>
  todayIso: string
}): Promise<string> {
  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Project: ${input.roomTitle}`,
    `Members: ${input.members.map((m) => m.displayName).join(", ") || "None"}`,
    `Current board tasks (JSON): ${JSON.stringify(input.tasks)}`,
    "",
    "Write a concise, friendly team check-in message (2-4 short sentences or bullets, plain text, no markdown headers) highlighting:",
    "1) Any tasks that are blocked or overdue relative to today's date (mention task IDs and owners).",
    "2) What is currently in progress and one clear next step to unblock or keep momentum.",
    "If the board is empty, suggest pasting a brief with @cohort extract.",
  ].join("\n")

  const response = await callGenerateContent({
    contents: prompt,
    maxOutputTokens: 600,
    config: {
      systemInstruction:
        "You are @cohort, a helpful, concise teammate in a student project group chat. Be direct, practical, and only cite tasks and dates actually on the board.",
    },
  })

  return (
    response.text?.trim().slice(0, 3000) ||
    "Quick check-in: take a look at your blocked and upcoming tasks on the board!"
  )
}

export async function generateProactiveNudgeWithGemini(input: {
  roomTitle: string
  reason: "stale_blocked" | "deadline_soon" | "room_idle"
  summaryContext: string
  tasks: Array<{
    id: string
    title: string
    suggested_owner: string
    due_date: string
    status: string
  }>
  members: Array<{ displayName: string }>
  todayIso: string
}): Promise<string> {
  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Project: ${input.roomTitle}`,
    `Trigger: ${input.reason}`,
    `Observation: ${input.summaryContext}`,
    `Members: ${input.members.map((m) => m.displayName).join(", ") || "None"}`,
    `Current tasks (JSON): ${JSON.stringify(input.tasks)}`,
    "",
    "You noticed this on your own while watching the room board. Write a helpful, non-nagging proactive teammate message (2 short sentences max, plain text, no markdown headers).",
    "Cite the exact task ID and @owner if applicable, and suggest one concrete next step (e.g., splitting a blocker, updating status with @cohort mark, or picking a quick win).",
  ].join("\n")

  const response = await callGenerateContent({
    contents: prompt,
    maxOutputTokens: 300,
    config: {
      systemInstruction:
        "You are @cohort, an attentive AI teammate participating alongside students in a project room. Be warm, concise, and factual—only cite tasks, owners, and dates that exist on the board.",
    },
  })

  return (
    response.text?.trim().slice(0, 1500) ||
    `Heads up team — ${input.summaryContext} Drop an update here or run "@cohort check-in" if you want to reprioritize.`
  )
}

function clampPlainTextReply(text: string, maxLen = 600): string {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\*\*([\s\S]*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim()

  if (cleaned.length <= maxLen) return cleaned

  const head = cleaned.slice(0, maxLen)
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "))
  if (sentenceEnd >= Math.floor(maxLen * 0.55)) {
    return head.slice(0, sentenceEnd + 1).trimEnd()
  }

  const bounded = cleaned.slice(0, maxLen - 1)
  const lastSpace = bounded.lastIndexOf(" ")
  const cut = lastSpace >= Math.floor(maxLen * 0.6) ? bounded.slice(0, lastSpace) : bounded
  return `${cut.trimEnd()}…`
}

export async function generateCohortReplyWithGemini(input: {
  roomTitle: string
  roomSummary: string
  tasks: Array<{
    id: string
    title: string
    description?: string
    suggested_owner: string
    due_date: string
    status: string
  }>
  members: Array<{ displayName: string }>
  messages: Array<{
    senderName: string
    role: string
    text: string
    createdAt?: string
  }>
  question: string
  todayIso: string
}): Promise<string> {
  const validTaskIds = input.tasks.map((t) => t.id)
  const chatHistory =
    input.messages.length > 0
      ? input.messages
          .map(
            (m) =>
              `- ${m.role === "assistant" ? "@cohort" : m.senderName}: ${m.text.trim().slice(0, 500)}`
          )
          .join("\n")
      : "No recent messages."

  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Room title: ${input.roomTitle}`,
    `Room summary: ${input.roomSummary || "No summary yet."}`,
    `Members: ${input.members.map((m) => m.displayName).join(", ") || "None"}`,
    `Valid task IDs on the board: ${validTaskIds.join(", ") || "NONE (board is empty)"}`,
    `Board tasks (JSON): ${JSON.stringify(input.tasks)}`,
    "",
    "Recent messages (oldest to newest):",
    chatHistory,
    "",
    `Teammate question/message: ${input.question.trim().slice(0, 2000)}`,
    "",
    "Respond concisely in plain text (no markdown, no bolding, no headers, no code fences).",
    "Maximum length: 600 characters (aim for 1-3 short sentences under 550 characters).",
    "Only cite task IDs that actually appear in the valid task IDs list above; never invent task IDs, owners, or dates.",
  ].join("\n")

  const response = await callGenerateContent({
    contents: prompt,
    maxOutputTokens: 600,
    config: {
      systemInstruction:
        "You are @cohort, a helpful and concise teammate in a student group project room. Answer questions using only the room summary, board tasks, members, and recent messages provided. Reply in plain text only, never exceed 600 characters, and cite only task IDs that exist on the board.",
    },
  })

  const raw = (response.text ?? "").trim()
  if (!raw) {
    return clampPlainTextReply(
      validTaskIds.length > 0
        ? `I'm tracking ${validTaskIds.length} tasks (${validTaskIds.slice(0, 5).join(", ")}). Ask about a specific task or run "@cohort check-in" for a full summary.`
        : 'There are no tasks on the board yet. Paste a brief with "@cohort extract <brief>" or add a task manually to get started.'
    )
  }

  return clampPlainTextReply(raw, 600)
}

export async function generateSandboxStarterWithGemini(input: {
  roomTitle: string
  projectSummary: string
  taskId: string
  taskTitle: string
  taskDescription: string
  taskType: TaskType
  templateMode: SandboxTemplateMode
  owner: string
  dueDate: string
}): Promise<SandboxFiles> {

  const modeInstructions =
    input.templateMode === "react"
      ? [
          "Generate a clean, working single-file React prototype tailored specifically to this task.",
          "Return primaryCode as valid JSX for src/App.jsx (must default export `App`, may import React and any React hooks from 'react', and no external third-party packages).",
          "Return secondaryCode as complete, modern CSS for src/styles.css.",
          "Return extraCode as empty string.",
        ].join(" ")
      : input.templateMode === "vanilla" || input.templateMode === "design"
        ? [
            "Generate a crisp, interactive HTML/CSS/JS prototype or wireframe tailored to this task.",
            "Return primaryCode as valid HTML body/document for index.html (without inline <script> or <style> tags).",
            "Return secondaryCode as CSS for styles.css.",
            "Return extraCode as vanilla browser JS for script.js.",
          ].join(" ")
        : input.templateMode === "backend"
          ? [
              "Generate a clean Next.js App Router API route handler (`handler.ts`) and JSON request/response schema (`schema.json`) tailored to this task.",
              "Return primaryCode as TypeScript for handler.ts.",
              "Return secondaryCode as valid JSON for schema.json.",
              "Return extraCode as empty string.",
            ].join(" ")
          : [
              "Generate a practical, structured Markdown research/planning starter brief (`RESEARCH_BRIEF.md`) with real questions, comparison table, and deliverable checklist tailored to this task.",
              "Return primaryCode as Markdown for RESEARCH_BRIEF.md.",
              "Return secondaryCode and extraCode as empty strings.",
            ].join(" ")

  const prompt = [
    `Project: ${input.roomTitle}`,
    `Project Summary: ${input.projectSummary || "Student team project"}`,
    `Task ${input.taskId}: ${input.taskTitle}`,
    `Task Description: ${input.taskDescription || input.taskTitle}`,
    `Task Discipline: ${input.taskType}`,
    `Template Mode: ${input.templateMode}`,
    `Owner: ${input.owner} | Due: ${input.dueDate}`,
    "",
    modeInstructions,
    "Keep code concise, immediately runnable with realistic sample data, and free of placeholder TODO stubs where real interactivity can be shown.",
  ].join("\n")

  const response = await callGenerateContent({
    contents: prompt,
    maxOutputTokens: 8000,
    config: {
      systemInstruction:
        "You are @cohort, helping a student team turn a Kanban task into an immediate runnable starter prototype. Return strict JSON matching the schema.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          primaryCode: {
            type: Type.STRING,
            description: "Primary file contents (src/App.jsx, index.html, handler.ts, or RESEARCH_BRIEF.md).",
          },
          secondaryCode: {
            type: Type.STRING,
            description: "Secondary file contents (src/styles.css, styles.css, schema.json, or empty string).",
          },
          extraCode: {
            type: Type.STRING,
            description: "Optional script.js contents for vanilla/design templates, otherwise empty string.",
          },
        },
        required: ["primaryCode", "secondaryCode", "extraCode"],
      },
    },
  })

  const rawText = (response.text ?? "").trim()
  if (!rawText) {
    throw new GeminiBadOutputError("Gemini returned an empty starter template. Please try again.")
  }

  let parsed: {
    primaryCode?: unknown
    secondaryCode?: unknown
    extraCode?: unknown
  }
  try {
    parsed = JSON.parse(rawText) as {
      primaryCode?: unknown
      secondaryCode?: unknown
      extraCode?: unknown
    }
  } catch {
    throw new GeminiBadOutputError(
      "Gemini returned malformed starter code JSON. Please try again."
    )
  }

  const primary = String(parsed.primaryCode || "").trim()
  const secondary = String(parsed.secondaryCode || "").trim()
  const extra = String(parsed.extraCode || "").trim()

  if (!primary) {
    throw new GeminiBadOutputError("Gemini returned an empty starter template. Please try again.")
  }

  if (input.templateMode === "react") {
    return {
      "src/App.jsx": primary.slice(0, 24000),
      "src/styles.css": secondary.slice(0, 12000),
    }
  }
  if (input.templateMode === "vanilla" || input.templateMode === "design") {
    return {
      "index.html": primary.slice(0, 24000),
      "styles.css": secondary.slice(0, 12000),
      "script.js": extra.slice(0, 12000),
    }
  }
  if (input.templateMode === "backend") {
    return {
      "handler.ts": primary.slice(0, 24000),
      "schema.json": secondary.slice(0, 12000),
    }
  }
  return {
    "RESEARCH_BRIEF.md": primary.slice(0, 24000),
  }
}


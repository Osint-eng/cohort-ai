export type AgentAggressiveness = "low" | "medium" | "high"
export type AgentStatus = "watching" | "thinking"

export type ProactiveTriggerReason = "stale_blocked" | "deadline_soon" | "room_idle"

export interface ProactiveThresholds {
  label: string
  description: string
  cooldownMs: number
  blockedMs: number
  idleMs: number
  deadlineDays: number
}

export const PROACTIVE_THRESHOLDS: Record<AgentAggressiveness, ProactiveThresholds> = {
  low: {
    label: "Low",
    description: "Gentle nudges (48h blocked/idle, 24h before due dates)",
    cooldownMs: 12 * 60 * 60 * 1000,
    blockedMs: 48 * 60 * 60 * 1000,
    idleMs: 48 * 60 * 60 * 1000,
    deadlineDays: 1,
  },
  medium: {
    label: "Medium",
    description: "Balanced check-ins (24h blocked/idle, 48h before due dates)",
    cooldownMs: 4 * 60 * 60 * 1000,
    blockedMs: 24 * 60 * 60 * 1000,
    idleMs: 24 * 60 * 60 * 1000,
    deadlineDays: 2,
  },
  high: {
    label: "High",
    description: "Active teammate (6h blocked/idle, 72h before due dates)",
    cooldownMs: 45 * 60 * 1000,
    blockedMs: 6 * 60 * 60 * 1000,
    idleMs: 6 * 60 * 60 * 1000,
    deadlineDays: 3,
  },
}

export const MIN_PULSE_CHECK_INTERVAL_MS = 5 * 60 * 1000

export function normalizeAggressiveness(value: unknown): AgentAggressiveness {
  if (value === "low" || value === "medium" || value === "high") {
    return value
  }
  return "medium"
}

export function getPulseCheckIntervalMs(aggressiveness: AgentAggressiveness): number {
  return Math.max(MIN_PULSE_CHECK_INTERVAL_MS, PROACTIVE_THRESHOLDS[aggressiveness].cooldownMs / 8)
}

export function isWithinPulseCheckThrottle(
  aggressiveness: AgentAggressiveness,
  lastPulseCheckAtIso?: string,
  nowMs = Date.now()
): boolean {
  if (!lastPulseCheckAtIso) return false
  const lastCheckMs = Date.parse(lastPulseCheckAtIso)
  if (Number.isNaN(lastCheckMs)) return false
  return nowMs - lastCheckMs < getPulseCheckIntervalMs(aggressiveness)
}

export function estimateDailyPulseReads(params: {
  aggressiveness: AgentAggressiveness
  taskCount: number
  memberCount: number
}): {
  intervalMinutes: number
  checksPerDay: number
  readsPerCheck: number
  dailyReadsPerRoom: number
} {
  const intervalMinutes = getPulseCheckIntervalMs(params.aggressiveness) / 60_000
  const checksPerDay = 1440 / intervalMinutes
  const readsPerCheck = params.taskCount + params.memberCount + 3
  return {
    intervalMinutes,
    checksPerDay,
    readsPerCheck,
    dailyReadsPerRoom: checksPerDay * readsPerCheck,
  }
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

export function normalizeTzOffsetMinutes(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= -840 && value <= 840) {
    return value
  }
  return 0
}

export function getLocalTodayIso(nowMs = Date.now(), tzOffsetMin = 0): string {
  const safeOffset = normalizeTzOffsetMinutes(tzOffsetMin)
  const localMs = nowMs - safeOffset * 60_000
  return new Date(localMs).toISOString().slice(0, 10)
}

function parseIsoCalendarParts(clean: string): { year: number; month: number; day: number } | null {
  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!isoMatch) return null
  const year = Number(isoMatch[1])
  const month = Number(isoMatch[2]) - 1
  const day = Number(isoMatch[3])
  const probe = new Date(Date.UTC(year, month, day))
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month ||
    probe.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

export function getDueEndOfDayMs(
  dueDateStr: string,
  tzOffsetMin = 0,
  nowMs = Date.now()
): number | null {
  const clean = dueDateStr.trim()
  if (!clean || /^tbd$/i.test(clean)) return null

  const safeOffset = normalizeTzOffsetMinutes(tzOffsetMin)
  const isoParts = parseIsoCalendarParts(clean)
  if (isoParts) {
    return Date.UTC(isoParts.year, isoParts.month, isoParts.day, 23, 59, 59) + safeOffset * 60_000
  }

  const parsedLegacy = parseTaskDueDate(clean, nowMs, safeOffset)
  return parsedLegacy ? parsedLegacy.getTime() : null
}

export function computeDaysLeft(
  dueDateStr: string,
  nowMs = Date.now(),
  tzOffsetMin = 0
): number | null {
  const endMs = getDueEndOfDayMs(dueDateStr, tzOffsetMin, nowMs)
  if (endMs === null) return null
  return (endMs - nowMs) / 86_400_000
}

export function parseTaskDueDate(
  dueDateStr: string,
  nowMs = Date.now(),
  tzOffsetMin?: number
): Date | null {
  const clean = dueDateStr.trim()
  if (!clean || /^tbd$/i.test(clean)) return null

  const isoParts = parseIsoCalendarParts(clean)
  if (isoParts) {
    if (tzOffsetMin !== undefined) {
      const safeOffset = normalizeTzOffsetMinutes(tzOffsetMin)
      return new Date(
        Date.UTC(isoParts.year, isoParts.month, isoParts.day, 23, 59, 59) + safeOffset * 60_000
      )
    }
    return new Date(isoParts.year, isoParts.month, isoParts.day, 23, 59, 59)
  }

  // Legacy fallback for older rooms that stored labels such as "Nov 20"
  const shortMatch = clean.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?$/)
  if (shortMatch) {
    const month = MONTH_INDEX[shortMatch[1].toLowerCase()]
    const day = Number(shortMatch[2])
    if (month === undefined || day < 1 || day > 31) return null

    if (tzOffsetMin !== undefined) {
      const safeOffset = normalizeTzOffsetMinutes(tzOffsetMin)
      const localNow = new Date(nowMs - safeOffset * 60_000)
      let year = shortMatch[3] ? Number(shortMatch[3]) : localNow.getUTCFullYear()
      let candidateMs = Date.UTC(year, month, day, 23, 59, 59) + safeOffset * 60_000
      if (!shortMatch[3]) {
        const diffDays = (candidateMs - nowMs) / 86_400_000
        if (diffDays < -180) {
          year += 1
          candidateMs = Date.UTC(year, month, day, 23, 59, 59) + safeOffset * 60_000
        } else if (diffDays > 180) {
          year -= 1
          candidateMs = Date.UTC(year, month, day, 23, 59, 59) + safeOffset * 60_000
        }
      }
      const candidate = new Date(candidateMs)
      return Number.isNaN(candidate.getTime()) ? null : candidate
    }

    const now = new Date(nowMs)
    let year = shortMatch[3] ? Number(shortMatch[3]) : now.getFullYear()
    let candidate = new Date(year, month, day, 23, 59, 59)

    // Handle year wraparound for undated labels like "Jan 05" evaluated in December
    if (!shortMatch[3]) {
      const diffDays = (candidate.getTime() - nowMs) / 86_400_000
      if (diffDays < -180) {
        year += 1
        candidate = new Date(year, month, day, 23, 59, 59)
      } else if (diffDays > 180) {
        year -= 1
        candidate = new Date(year, month, day, 23, 59, 59)
      }
    }
    return Number.isNaN(candidate.getTime()) ? null : candidate
  }

  const fallback = Date.parse(clean)
  return Number.isNaN(fallback) ? null : new Date(fallback)
}

export function formatTaskDueDateDisplay(dueDateStr: string, nowMs = Date.now()): string {
  const clean = dueDateStr.trim()
  if (!clean || /^tbd$/i.test(clean)) return "TBD"

  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    const year = Number(isoMatch[1])
    const month = Number(isoMatch[2]) - 1
    const day = Number(isoMatch[3])
    const dt = new Date(year, month, day, 12, 0, 0)
    if (
      !Number.isNaN(dt.getTime()) &&
      dt.getFullYear() === year &&
      dt.getMonth() === month &&
      dt.getDate() === day
    ) {
      const currentYear = new Date(nowMs).getFullYear()
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        ...(year !== currentYear ? { year: "numeric" } : {}),
      }).format(dt)
    }
  }

  return clean
}

export function toDueDateInputValue(dueDateStr: string, nowMs = Date.now()): string {
  const clean = dueDateStr.trim()
  if (!clean || /^tbd$/i.test(clean)) return ""
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean

  const parsed = parseTaskDueDate(clean, nowMs)
  if (!parsed) return ""
  const y = parsed.getFullYear()
  const m = String(parsed.getMonth() + 1).padStart(2, "0")
  const d = String(parsed.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function getTodayDateInputValue(nowMs = Date.now()): string {
  const dt = new Date(nowMs)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, "0")
  const d = String(dt.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export const BASE_NUDGE_BACKOFF_MS = 24 * 60 * 60 * 1000
export const MAX_NUDGE_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_NUDGE_STATE_ENTRIES = 40

export interface NudgeStateEntry {
  atMs: number
  n: number
}

export type NudgeStateMap = Record<string, NudgeStateEntry>

export function getNudgeBackoffMs(n: number): number {
  const safeN = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  return Math.min(BASE_NUDGE_BACKOFF_MS * Math.pow(2, safeN), MAX_NUDGE_BACKOFF_MS)
}

export function isTaskNudgeEligible(
  entry: NudgeStateEntry | undefined,
  nowMs = Date.now()
): boolean {
  if (!entry) return true
  return nowMs - entry.atMs >= getNudgeBackoffMs(entry.n)
}

export function parseNudgeState(raw: unknown): NudgeStateMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {}
  }
  const result: NudgeStateMap = {}
  for (const [taskId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const rec = value as { at?: unknown; atMs?: unknown; n?: unknown }
    const rawAt = rec.at ?? rec.atMs
    let atMs = Number.NaN
    if (typeof rawAt === "string") {
      atMs = Date.parse(rawAt)
    } else if (rawAt instanceof Date) {
      atMs = rawAt.getTime()
    } else if (typeof rawAt === "number") {
      atMs = rawAt
    } else if (
      rawAt &&
      typeof rawAt === "object" &&
      "toDate" in rawAt &&
      typeof (rawAt as { toDate: () => Date }).toDate === "function"
    ) {
      atMs = (rawAt as { toDate: () => Date }).toDate().getTime()
    }
    if (!Number.isFinite(atMs)) continue
    const rawN = typeof rec.n === "number" ? Math.floor(rec.n) : 0
    result[taskId] = {
      atMs,
      n: Number.isFinite(rawN) && rawN >= 0 ? rawN : 0,
    }
  }
  return result
}

export function buildNextNudgeState(params: {
  currentState: NudgeStateMap
  tasks: Array<{ id: string; status: string }>
  nudgedTaskId?: string
  nowMs?: number
}): Record<string, { at: Date; n: number }> {
  const nowMs = params.nowMs ?? Date.now()
  const activeTaskIds = new Set(
    params.tasks.filter((t) => t.status !== "done").map((t) => t.id)
  )

  const entries = new Map<string, NudgeStateEntry>()
  for (const [taskId, entry] of Object.entries(params.currentState)) {
    if (activeTaskIds.has(taskId)) {
      entries.set(taskId, entry)
    }
  }

  if (
    params.nudgedTaskId &&
    params.nudgedTaskId !== "board" &&
    activeTaskIds.has(params.nudgedTaskId)
  ) {
    const prev = entries.get(params.nudgedTaskId)
    entries.set(params.nudgedTaskId, {
      atMs: nowMs,
      n: (prev?.n ?? 0) + 1,
    })
  }

  const sorted = Array.from(entries.entries()).sort((a, b) => {
    if (a[0] === params.nudgedTaskId) return -1
    if (b[0] === params.nudgedTaskId) return 1
    return b[1].atMs - a[1].atMs
  })

  const bounded = sorted.slice(0, MAX_NUDGE_STATE_ENTRIES)
  const output: Record<string, { at: Date; n: number }> = {}
  for (const [taskId, entry] of bounded) {
    output[taskId] = {
      at: new Date(entry.atMs),
      n: entry.n,
    }
  }
  return output
}

export interface ProactiveEvaluationInput {
  aggressiveness: AgentAggressiveness
  lastProactiveAtIso?: string
  roomCreatedAtIso?: string
  nudgeState?: NudgeStateMap
  tasks: Array<{
    id: string
    title: string
    suggested_owner: string
    due_date: string
    status: "todo" | "in_progress" | "blocked" | "done"
    updatedAt?: string
  }>
  messages: Array<{
    role: string
    senderId: string
    createdAt?: string
  }>
  nowMs?: number
  tzOffsetMinutes?: number
}

export interface ProactiveEvaluationResult {
  shouldNudge: boolean
  reason?: ProactiveTriggerReason
  targetTaskId?: string
  summaryContext?: string
}

export function evaluateProactiveNudge(input: ProactiveEvaluationInput): ProactiveEvaluationResult {
  const nowMs = input.nowMs ?? Date.now()
  const tzOffsetMin = normalizeTzOffsetMinutes(input.tzOffsetMinutes)
  const cfg = PROACTIVE_THRESHOLDS[input.aggressiveness]
  const nudgeState = input.nudgeState ?? {}

  if (input.lastProactiveAtIso) {
    const lastProactiveMs = Date.parse(input.lastProactiveAtIso)
    if (!Number.isNaN(lastProactiveMs) && nowMs - lastProactiveMs < cfg.cooldownMs) {
      return { shouldNudge: false }
    }
  }

  // 1. Check for tasks stuck in blocked state past threshold (skip snoozed tasks)
  for (const task of input.tasks) {
    if (task.status !== "blocked" || !task.updatedAt) continue
    if (!isTaskNudgeEligible(nudgeState[task.id], nowMs)) continue
    const updatedMs = Date.parse(task.updatedAt)
    if (!Number.isNaN(updatedMs) && nowMs - updatedMs >= cfg.blockedMs) {
      const hoursBlocked = Math.max(1, Math.round((nowMs - updatedMs) / 3_600_000))
      return {
        shouldNudge: true,
        reason: "stale_blocked",
        targetTaskId: task.id,
        summaryContext: `Task ${task.id} ("${task.title}", assigned to ${task.suggested_owner}) has been blocked for ~${hoursBlocked}h.`,
      }
    }
  }

  // 2. Check for approaching or overdue deadlines on incomplete tasks (skip snoozed tasks)
  const openTasks = input.tasks.filter((t) => t.status !== "done")
  for (const task of openTasks) {
    if (!isTaskNudgeEligible(nudgeState[task.id], nowMs)) continue
    const dueDt = parseTaskDueDate(task.due_date, nowMs, tzOffsetMin)
    if (!dueDt) continue
    const msUntilDue = dueDt.getTime() - nowMs
    // Alert if overdue (up to 14 days old) or within deadlineDays
    if (msUntilDue <= cfg.deadlineDays * 86_400_000 && msUntilDue >= -14 * 86_400_000) {
      const daysText =
        msUntilDue < 0
          ? `overdue since ${task.due_date}`
          : msUntilDue < 86_400_000
            ? `due within 24h (${task.due_date})`
            : `due soon (${task.due_date})`
      return {
        shouldNudge: true,
        reason: "deadline_soon",
        targetTaskId: task.id,
        summaryContext: `Task ${task.id} ("${task.title}", ${task.suggested_owner}, currently ${task.status.replace("_", " ")}) is ${daysText}.`,
      }
    }
  }

  // 3. Check for room inactivity when open tasks exist (never double-post idle nudges if bot spoke last)
  if (openTasks.length > 0) {
    const sortedMsgs = [...input.messages]
      .filter((m) => m.createdAt && !Number.isNaN(Date.parse(m.createdAt)))
      .sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))

    const latestMsg = sortedMsgs[0]
    const lastActivityIso = latestMsg?.createdAt || input.roomCreatedAtIso
    const lastMsgWasBot = latestMsg?.senderId === "cohort" || latestMsg?.role === "assistant"

    if (lastActivityIso && !lastMsgWasBot) {
      const idleMs = nowMs - Date.parse(lastActivityIso)
      if (!Number.isNaN(idleMs) && idleMs >= cfg.idleMs) {
        const idleHours = Math.max(1, Math.round(idleMs / 3_600_000))
        return {
          shouldNudge: true,
          reason: "room_idle",
          targetTaskId: "board",
          summaryContext: `No team chat activity for ~${idleHours}h while ${openTasks.length} open task${openTasks.length === 1 ? "" : "s"} remain on the board.`,
        }
      }
    }
  }

  return { shouldNudge: false }
}

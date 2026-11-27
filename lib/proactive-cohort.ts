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

export function parseTaskDueDate(dueDateStr: string, nowMs = Date.now()): Date | null {
  const clean = dueDateStr.trim()
  if (!clean || /^tbd$/i.test(clean)) return null

  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    const dt = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]), 23, 59, 59)
    return Number.isNaN(dt.getTime()) ? null : dt
  }

  const shortMatch = clean.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?$/)
  if (shortMatch) {
    const month = MONTH_INDEX[shortMatch[1].toLowerCase()]
    const day = Number(shortMatch[2])
    if (month === undefined || day < 1 || day > 31) return null

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

export interface ProactiveEvaluationInput {
  aggressiveness: AgentAggressiveness
  lastProactiveAtIso?: string
  roomCreatedAtIso?: string
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
}

export interface ProactiveEvaluationResult {
  shouldNudge: boolean
  reason?: ProactiveTriggerReason
  targetTaskId?: string
  summaryContext?: string
}

export function evaluateProactiveNudge(input: ProactiveEvaluationInput): ProactiveEvaluationResult {
  const nowMs = input.nowMs ?? Date.now()
  const cfg = PROACTIVE_THRESHOLDS[input.aggressiveness]

  if (input.lastProactiveAtIso) {
    const lastProactiveMs = Date.parse(input.lastProactiveAtIso)
    if (!Number.isNaN(lastProactiveMs) && nowMs - lastProactiveMs < cfg.cooldownMs) {
      return { shouldNudge: false }
    }
  }

  // 1. Check for tasks stuck in blocked state past threshold
  for (const task of input.tasks) {
    if (task.status !== "blocked" || !task.updatedAt) continue
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

  // 2. Check for approaching or overdue deadlines on incomplete tasks
  const openTasks = input.tasks.filter((t) => t.status !== "done")
  for (const task of openTasks) {
    const dueDt = parseTaskDueDate(task.due_date, nowMs)
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

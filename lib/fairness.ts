import { normalizeTaskWeight, type LogEntry, type Member, type Task } from "./api"

export const INACTIVE_THRESHOLD_HOURS = 48

export type MemberContributionStatus =
  | "Balanced"
  | "Leading"
  | "Behind"
  | "Blocked"
  | "Inactive"
  | "No data"

export type MemberContribution = {
  member: Member
  handle: string
  assignedCount: number
  completedCount: number
  inProgressCount: number
  blockedCount: number
  todoCount: number
  logActionsCount: number
  completionsLogged: number
  startsLogged: number
  blockersLogged: number
  points: number
  sharePercent: number
  lastContributionAt: string | null
  inactiveHours: number | null
  isInactive: boolean
  statusFlag: MemberContributionStatus
}

export type DailyContributionBucket = {
  dateKey: string
  label: string
  total: number
  completions: number
  updates: number
  byActor: Record<string, number>
}

export type FairnessReport = {
  fairnessScore: number | null
  fairnessLabel: "Balanced" | "Moderate skew" | "Uneven" | "No activity"
  totalTasks: number
  completedTasks: number
  blockedTasks: number
  inProgressTasks: number
  totalLogs: number
  targetSharePercent: number
  blockedMembersCount: number
  inactiveMembersCount: number
  unassignedTasksCount: number
  members: MemberContribution[]
  dailyBuckets: DailyContributionBucket[]
  timeline: LogEntry[]
}

const OTHER_ACTION_POINTS = 0.5
const MAX_OTHER_ACTION_POINTS = 2

function matchTaskOwnerUid(task: Task, members: Member[]): string {
  if (task.owner_uid && members.some((m) => m.uid === task.owner_uid)) {
    return task.owner_uid
  }
  const cleanHandle = task.suggested_owner.replace(/^@/, "").trim().toLowerCase()
  if (!cleanHandle) return ""
  const exact = members.find((m) => m.name.toLowerCase() === cleanHandle)
  if (exact) return exact.uid
  const firstName = members.find(
    (m) => m.name.split(/\s+/)[0]?.toLowerCase() === cleanHandle
  )
  return firstName ? firstName.uid : ""
}

function parseIsoMs(iso?: string | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

function toLocalDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function computeFairnessReport(input: {
  members: Member[]
  tasks: Task[]
  logs: LogEntry[]
  nowMs?: number
}): FairnessReport {
  const nowMs = input.nowMs ?? Date.now()
  const approvedMembers = input.members.filter((m) => m.role !== "pending")
  const memberCount = approvedMembers.length
  const targetSharePercent = memberCount > 0 ? Math.round(100 / memberCount) : 0

  // Exclude synthetic @cohort bot entries when measuring human student workload
  const humanLogs = input.logs.filter(
    (log) => log.actorId && log.actorId !== "cohort" && log.actor !== "cohort"
  )

  const taskWeightById = new Map<string, 1 | 2 | 3>()
  const tasksByUid = new Map<string, Task[]>()
  let unassignedTasksCount = 0
  for (const task of input.tasks) {
    taskWeightById.set(task.id, normalizeTaskWeight(task.weight) ?? 1)
    const uid = matchTaskOwnerUid(task, approvedMembers)
    if (!uid) {
      unassignedTasksCount += 1
      continue
    }
    const list = tasksByUid.get(uid) || []
    list.push(task)
    tasksByUid.set(uid, list)
  }

  // Sort chronologically (oldest first) so the earliest 'completed' / 'started'
  // log per task_id earns credit regardless of Firestore's descending query order.
  const chronologicalLogs = humanLogs
    .map((log, index) => ({ log, index, ms: parseIsoMs(log.ts) }))
    .sort((a, b) => {
      if (a.ms !== null && b.ms !== null && a.ms !== b.ms) {
        return a.ms - b.ms
      }
      if (a.ms !== null && b.ms === null) return -1
      if (a.ms === null && b.ms !== null) return 1
      return a.index - b.index
    })
    .map((entry) => entry.log)

  const firstCompletedTaskIds = new Set<string>()
  const firstStartedTaskIds = new Set<string>()
  const firstBlockedByActorTask = new Set<string>()

  const completionPointsByUid = new Map<string, number>()
  const startPointsByUid = new Map<string, number>()
  const otherPointsByUid = new Map<string, number>()
  const logsByUid = new Map<string, LogEntry[]>()

  for (const log of humanLogs) {
    const list = logsByUid.get(log.actorId) || []
    list.push(log)
    logsByUid.set(log.actorId, list)
  }

  for (const log of chronologicalLogs) {
    const action = log.action.trim().toLowerCase()
    const taskKey = log.task_id || log.id

    if (action === "completed") {
      if (!firstCompletedTaskIds.has(taskKey)) {
        firstCompletedTaskIds.add(taskKey)
        const weight = taskWeightById.get(log.task_id) ?? 1
        completionPointsByUid.set(
          log.actorId,
          (completionPointsByUid.get(log.actorId) || 0) + 3 * weight
        )
      }
      continue
    }

    if (action === "started") {
      if (!firstStartedTaskIds.has(taskKey)) {
        firstStartedTaskIds.add(taskKey)
        startPointsByUid.set(log.actorId, (startPointsByUid.get(log.actorId) || 0) + 1)
      }
      continue
    }

    // Status reset toggles add nothing to prevent toggling done <-> todo for points
    if (action === "moved to to do" || action === "todo") {
      continue
    }

    // Prevent repeated blocked toggles on the same task by the same actor from farming points
    if (action === "blocked") {
      const blockedKey = `${log.actorId}::${taskKey}`
      if (firstBlockedByActorTask.has(blockedKey)) {
        continue
      }
      firstBlockedByActorTask.add(blockedKey)
    }

    otherPointsByUid.set(
      log.actorId,
      (otherPointsByUid.get(log.actorId) || 0) + OTHER_ACTION_POINTS
    )
  }

  const rawRows = approvedMembers.map((member) => {
    const memberTasks = tasksByUid.get(member.uid) || []
    const memberLogs = logsByUid.get(member.uid) || []

    let completedCount = 0
    let inProgressCount = 0
    let blockedCount = 0
    let todoCount = 0
    for (const t of memberTasks) {
      if (t.status === "done") completedCount += 1
      else if (t.status === "in_progress") inProgressCount += 1
      else if (t.status === "blocked") blockedCount += 1
      else todoCount += 1
    }

    let completionsLogged = 0
    let startsLogged = 0
    let blockersLogged = 0
    let latestLogMs: number | null = null
    let latestLogIso: string | null = null

    for (const log of memberLogs) {
      if (log.action === "completed") completionsLogged += 1
      else if (log.action === "started") startsLogged += 1
      else if (log.action === "blocked") blockersLogged += 1

      const logMs = parseIsoMs(log.ts)
      if (logMs !== null && (latestLogMs === null || logMs > latestLogMs)) {
        latestLogMs = logMs
        latestLogIso = log.ts
      }
    }

    const completionPoints = completionPointsByUid.get(member.uid) || 0
    const startPoints = startPointsByUid.get(member.uid) || 0
    const otherPoints = Math.min(
      MAX_OTHER_ACTION_POINTS,
      otherPointsByUid.get(member.uid) || 0
    )
    const points = Number((completionPoints + startPoints + otherPoints).toFixed(1))

    const lastSeenMs = parseIsoMs(member.lastSeenAt)
    const activityRefMs = latestLogMs ?? lastSeenMs
    const inactiveHours =
      activityRefMs !== null
        ? Math.max(0, Math.floor((nowMs - activityRefMs) / 3_600_000))
        : null

    const hasRoomWork = input.tasks.length > 0 || humanLogs.length > 0
    const isInactive =
      hasRoomWork &&
      ((latestLogMs === null && points === 0 && (inactiveHours ?? 0) >= 1) ||
        (latestLogMs !== null && (nowMs - latestLogMs) / 3_600_000 >= INACTIVE_THRESHOLD_HOURS))

    return {
      member,
      handle: `@${member.name.split(/\s+/)[0] || "member"}`,
      assignedCount: memberTasks.length,
      completedCount,
      inProgressCount,
      blockedCount,
      todoCount,
      logActionsCount: memberLogs.length,
      completionsLogged,
      startsLogged,
      blockersLogged,
      points,
      lastContributionAt: latestLogIso,
      inactiveHours,
      isInactive,
    }
  })

  const totalPoints = rawRows.reduce((sum, r) => sum + r.points, 0)

  const members: MemberContribution[] = rawRows.map((row) => {
    const sharePercent =
      totalPoints > 0 ? Math.round((row.points / totalPoints) * 100) : 0

    let statusFlag: MemberContributionStatus = "Balanced"
    if (totalPoints === 0) {
      statusFlag = "No data"
    } else if (row.blockedCount > 0) {
      statusFlag = "Blocked"
    } else if (row.isInactive) {
      statusFlag = "Inactive"
    } else if (memberCount > 1 && sharePercent >= targetSharePercent + 15) {
      statusFlag = "Leading"
    } else if (memberCount > 1 && sharePercent <= Math.max(0, targetSharePercent - 15)) {
      statusFlag = "Behind"
    }

    return {
      ...row,
      sharePercent,
      statusFlag,
    }
  })

  members.sort((a, b) => b.points - a.points || b.completionsLogged - a.completionsLogged)

  // Jain's Fairness Index: (sum x_i)^2 / (n * sum x_i^2) scaled to 0..100
  let fairnessScore: number | null = null
  let fairnessLabel: FairnessReport["fairnessLabel"] = "No activity"

  if (memberCount > 0 && totalPoints > 0) {
    const sumSq = members.reduce((sum, m) => sum + m.points * m.points, 0)
    const jain = sumSq > 0 ? (totalPoints * totalPoints) / (memberCount * sumSq) : 0
    fairnessScore = Math.max(0, Math.min(100, Math.round(jain * 100)))
    fairnessLabel =
      fairnessScore >= 80
        ? "Balanced"
        : fairnessScore >= 55
          ? "Moderate skew"
          : "Uneven"
  }

  // Build last 7 days contribution buckets from logs
  const bucketMap = new Map<string, DailyContributionBucket>()
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  })

  for (let offset = 6; offset >= 0; offset--) {
    const dayMs = nowMs - offset * 86_400_000
    const key = toLocalDateKey(dayMs)
    bucketMap.set(key, {
      dateKey: key,
      label: dayFormatter.format(new Date(dayMs)),
      total: 0,
      completions: 0,
      updates: 0,
      byActor: {},
    })
  }

  for (const log of humanLogs) {
    const ms = parseIsoMs(log.ts)
    if (ms === null) continue
    const key = toLocalDateKey(ms)
    const bucket = bucketMap.get(key)
    if (!bucket) continue
    bucket.total += 1
    if (log.action === "completed") bucket.completions += 1
    else bucket.updates += 1
    bucket.byActor[log.actorId] = (bucket.byActor[log.actorId] || 0) + 1
  }

  const completedTasks = input.tasks.filter((t) => t.status === "done").length
  const blockedTasks = input.tasks.filter((t) => t.status === "blocked").length
  const inProgressTasks = input.tasks.filter((t) => t.status === "in_progress").length

  return {
    fairnessScore,
    fairnessLabel,
    totalTasks: input.tasks.length,
    completedTasks,
    blockedTasks,
    inProgressTasks,
    totalLogs: humanLogs.length,
    targetSharePercent,
    blockedMembersCount: members.filter((m) => m.blockedCount > 0).length,
    inactiveMembersCount: members.filter((m) => m.isInactive).length,
    unassignedTasksCount,
    members,
    dailyBuckets: Array.from(bucketMap.values()),
    timeline: humanLogs,
  }
}

export function buildFairnessCsv(roomCode: string, roomTitle: string, report: FairnessReport): string {
  const escapeCsv = (val: string | number) => {
    const s = String(val)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const header = [
    "Room Code",
    "Room Title",
    "Member",
    "Role",
    "Assigned Tasks",
    "Completed",
    "In Progress",
    "Blocked",
    "Logged Actions",
    "Contribution Points",
    "Share (%)",
    "Status",
    "Last Contribution",
  ]

  const rows = report.members.map((m) => [
    roomCode,
    roomTitle,
    m.member.name,
    m.member.role,
    m.assignedCount,
    m.completedCount,
    m.inProgressCount,
    m.blockedCount,
    m.logActionsCount,
    m.points,
    m.sharePercent,
    m.statusFlag,
    m.lastContributionAt || "None",
  ])

  return [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n")
}

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  type QueryDocumentSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore"
import type { User } from "firebase/auth"
import { db, handleFirestoreError, OperationType } from "./firebase"
import {
  formatTaskDueDateDisplay,
  getTodayDateInputValue,
  normalizeAggressiveness,
  toDueDateInputValue,
  type AgentAggressiveness,
  type AgentStatus,
} from "./proactive-cohort"

import {
  normalizeTaskType,
  type SandboxFiles,
  type SandboxTemplateMode,
  type TaskType,
} from "./task-sandbox"

export { formatTaskDueDateDisplay, getTodayDateInputValue, toDueDateInputValue }
export type { AgentAggressiveness, AgentStatus, TaskType }

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done"
export type TaskWeight = 1 | 2 | 3

export function normalizeTaskWeight(value: unknown): TaskWeight | undefined {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(num)) return undefined
  const rounded = Math.round(num)
  if (rounded <= 1) return 1
  if (rounded === 2) return 2
  return 3
}

export type Task = {
  id: string
  title: string
  description?: string
  task_type?: TaskType
  weight?: TaskWeight
  suggested_owner: string
  owner_uid: string
  due_date: string
  status: TaskStatus
}
export type LogEntry = {
  id: string
  actorId: string
  actor: string
  action: string
  task_id: string
  note?: string
  ts: string
}
export type Message = {
  id: string
  senderId: string
  name: string
  text: string
  ts: string
  role: "user" | "assistant"
}
export type MemberRole = "owner" | "member" | "pending"
export type Member = {
  uid: string
  name: string
  photoURL: string
  role: MemberRole
  status: "active" | "pending"
  online: boolean
  lastSeenAt: string
}
export type Invite = {
  id: string
  createdBy: string
  createdAt: string
  expiresAt: string
  maxUses: number
  usedCount: number
  active: boolean
}
export type RoomMeta = {
  code: string
  title: string
  summary: string
  ownerId: string
  agentAggressiveness: AgentAggressiveness
  agentStatus: AgentStatus
  agentStatusAt?: string
  lastProactiveAt?: string
}

function parseRoomMeta(code: string, data: Record<string, unknown>): RoomMeta {
  return {
    code,
    title: String(data.title || "Project room"),
    summary: String(data.summary || ""),
    ownerId: String(data.ownerId || ""),
    agentAggressiveness: normalizeAggressiveness(data.agentAggressiveness),
    agentStatus: data.agentStatus === "thinking" ? "thinking" : "watching",
    agentStatusAt: data.agentStatusAt ? timestampToIso(data.agentStatusAt) : undefined,
    lastProactiveAt: data.lastProactiveAt ? timestampToIso(data.lastProactiveAt) : undefined,
  }
}

export class RoomNotFoundError extends Error {
  constructor() {
    super("Room not found")
    this.name = "RoomNotFoundError"
  }
}

export class InviteExpiredOrLimitError extends Error {
  constructor() {
    super("This invite link has expired or reached its limit")
    this.name = "InviteExpiredOrLimitError"
  }
}

export class RejectedCooldownError extends Error {
  untilIso: string
  constructor(untilIso: string) {
    super(`Your join request was declined. You can ask again after ${formatRetryAfterTime(untilIso)}.`)
    this.name = "RejectedCooldownError"
    this.untilIso = untilIso
  }
}

export const ROOM_CODE_REGEX = /^[A-Z0-9]{8}$/
export const PRESENCE_TTL_MS = 2 * 60 * 1000
export const MESSAGE_WINDOW_LIMIT = 100
export const OLDER_MESSAGES_PAGE_SIZE = 50
export const ACTIVITY_LOG_LIMIT = 100
export const REJECT_COOLDOWN_BASE_MS = 15 * 60 * 1000
export const REJECT_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000
export const RECENT_ROOMS_LIMIT = 8

export type RecentRoomEntry = { code: string; title: string }

export function getRecentRoomsStorageKey(uid: string): string {
  return `cohort:recentRooms:${uid}`
}

export function upsertRecentRoom<T extends { code: string }>(
  oldRooms: readonly T[],
  entry: T,
  maxCount = RECENT_ROOMS_LIMIT
): T[] {
  return [entry, ...oldRooms.filter((item) => item.code !== entry.code)].slice(0, maxCount)
}

const REDIRECT_FALLBACK_AUTH_CODES = new Set([
  "auth/popup-blocked",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
])

export function shouldFallbackToRedirectSignIn(error: unknown): boolean {
  const code =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : ""
  return REDIRECT_FALLBACK_AUTH_CODES.has(code)
}

export function computeRejectionCooldownMs(rejectionCount: number): number {
  const k = Math.max(1, Math.floor(rejectionCount))
  return Math.min(REJECT_COOLDOWN_BASE_MS * 2 ** (k - 1), REJECT_COOLDOWN_MAX_MS)
}

export function computeRejectionUntilDate(rejectedAtMs: number, rejectionCount: number): Date {
  return new Date(rejectedAtMs + computeRejectionCooldownMs(rejectionCount))
}

export function formatRetryAfterTime(untilIsoOrMs: string | number): string {
  const ms = typeof untilIsoOrMs === "number" ? untilIsoOrMs : Date.parse(untilIsoOrMs)
  if (Number.isNaN(ms)) return "a short cooldown"
  const date = new Date(ms)
  const sameDay =
    Math.abs(ms - Date.now()) < 12 * 60 * 60 * 1000 &&
    date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  ).format(date)
}

export type MessageCursor = QueryDocumentSnapshot

export function formatMessageWindowAscending(
  descMessages: Message[],
  maxCount = MESSAGE_WINDOW_LIMIT
): Message[] {
  const seen = new Set<string>()
  const uniqueDesc: Message[] = []
  for (const msg of descMessages) {
    if (seen.has(msg.id)) continue
    seen.add(msg.id)
    uniqueDesc.push(msg)
    if (uniqueDesc.length >= maxCount) break
  }
  return uniqueDesc.reverse()
}

export function mergeOlderMessages(
  existingMessages: Message[],
  olderMessagesAscending: Message[]
): Message[] {
  const existingIds = new Set(existingMessages.map((m) => m.id))
  const seenOlder = new Set<string>()
  const uniqueOlder: Message[] = []
  for (const msg of olderMessagesAscending) {
    if (existingIds.has(msg.id) || seenOlder.has(msg.id)) continue
    seenOlder.add(msg.id)
    uniqueOlder.push(msg)
  }
  return [...uniqueOlder, ...existingMessages]
}

export function mergeLiveMessages(
  existingMessages: Message[],
  liveAscending: Message[]
): Message[] {
  if (existingMessages.length === 0) return liveAscending
  const liveIds = new Set(liveAscending.map((m) => m.id))
  const retainedOlder = existingMessages.filter((m) => !liveIds.has(m.id))
  return [...retainedOlder, ...liveAscending]
}

export function mergeFairnessLogs(
  activityLogs: LogEntry[],
  fairnessLogs: LogEntry[]
): LogEntry[] {
  const byId = new Map<string, LogEntry>()
  for (const entry of activityLogs) {
    byId.set(entry.id, entry)
  }
  for (const entry of fairnessLogs) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry)
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const msA = Date.parse(a.ts)
    const msB = Date.parse(b.ts)
    if (!Number.isNaN(msA) && !Number.isNaN(msB) && msA !== msB) {
      return msB - msA
    }
    if (!Number.isNaN(msB) && Number.isNaN(msA)) return 1
    if (!Number.isNaN(msA) && Number.isNaN(msB)) return -1
    return b.id.localeCompare(a.id)
  })
}

export function estimateRoomOpenReads(params: {
  messageLimit?: number
  activityLimit?: number
  tasksCount: number
  membersCount: number
  fairnessLogsCount: number
}): number {
  const messageLimit = params.messageLimit ?? MESSAGE_WINDOW_LIMIT
  const activityLimit = params.activityLimit ?? ACTIVITY_LOG_LIMIT
  return (
    messageLimit +
    activityLimit +
    params.tasksCount +
    params.membersCount +
    1 +
    params.fairnessLogsCount
  )
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase()
}

export function getUserDisplayName(user: User): string {
  const emailPrefix = user.email ? user.email.split("@")[0] : ""
  return (user.displayName || emailPrefix || "Teammate").trim().slice(0, 80)
}

export function suggestDefaultRoomTitle(user: User | null): string {
  const name = user ? getUserDisplayName(user) : "Team"
  const firstName = name.split(/\s+/)[0] || "Team"
  const shortDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date())
  return `${firstName}’s Project – ${shortDate}`
}

export function isMemberOnline(member: Member, nowMs = Date.now()): boolean {
  if (!member.online) return false
  const seenMs = Date.parse(member.lastSeenAt)
  if (Number.isNaN(seenMs)) return false
  return nowMs - seenMs < PRESENCE_TTL_MS
}

export function formatMemberLastSeen(member: Member, nowMs = Date.now()): string {
  if (member.role === "pending") return "Pending"
  if (isMemberOnline(member, nowMs)) return "online"
  const seenMs = Date.parse(member.lastSeenAt)
  if (Number.isNaN(seenMs)) return "away"
  const mins = Math.max(1, Math.floor((nowMs - seenMs) / 60000))
  if (mins < 60) return `last seen ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `last seen ${hours}h ago`
  return `last seen ${Math.floor(hours / 24)}d ago`
}

export function getFriendlyErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please try again."
): string {
  if (error instanceof RoomNotFoundError) {
    return "Room not found. Check the code and try again."
  }
  if (error instanceof InviteExpiredOrLimitError || error instanceof RejectedCooldownError) {
    return error.message
  }

  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (!raw) return fallback

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        error?: string
        authInfo?: { emailVerified?: boolean | null }
      }
      const inner = parsed.error || ""
      const lowerInner = inner.toLowerCase()
      if (lowerInner.includes("permission") || lowerInner.includes("permission_denied")) {
        if (parsed.authInfo?.emailVerified === false) {
          return "Your Google account email isn’t verified. Please sign in with a verified Google account."
        }
        return "You don’t have permission to perform this action in this room."
      }
      if (lowerInner.includes("unauthenticated") || lowerInner.includes("auth")) {
        return "Your sign-in session expired. Please sign in again."
      }
      if (lowerInner.includes("quota") || lowerInner.includes("resource-exhausted")) {
        return "Daily database quota reached. Please try again later."
      }
      if (lowerInner.includes("offline") || lowerInner.includes("unavailable") || lowerInner.includes("network")) {
        return "Connection issue while syncing with the room. Please check your network and retry."
      }
      return fallback
    } catch {
      return fallback
    }
  }

  const lower = raw.toLowerCase()
  if (lower.includes("invite link has expired") || lower.includes("reached its limit")) {
    return "This invite link has expired or reached its limit"
  }
  if (lower.includes("email is not verified") || lower.includes("verified google account")) {
    return "Your Google account email isn’t verified. Please sign in with a verified Google account."
  }
  if (lower.includes("waiting for the room owner")) {
    return raw
  }
  if (lower.includes("missing or insufficient permissions") || lower.includes("permission-denied")) {
    return "You don’t have permission for that action. Please check your sign-in and room approval status."
  }
  if (lower.includes("too many") || lower.includes("reached the limit")) {
    return raw
  }
  if (lower.includes("confirm replacing")) {
    return raw
  }
  if (lower.includes("must be at least 3 characters")) {
    return raw
  }
  if (lower.includes("gemini_api_key")) {
    return "AI features aren’t configured on the server right now."
  }
  if (lower.includes("network") || lower.includes("failed to fetch")) {
    return "Network error — please check your connection and try again."
  }
  if (raw.length > 180) {
    return fallback
  }
  return raw
}

function makeClientId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function timestampToIso(value: unknown): string {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString()
  }
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  if (typeof value === "string") {
    return value
  }
  return new Date().toISOString()
}

function docToMessage(docId: string, data: Record<string, unknown>): Message {
  return {
    id: String(data.id || docId),
    senderId: String(data.senderId || ""),
    name: String(data.senderName || "Teammate"),
    text: String(data.text || ""),
    ts: timestampToIso(data.createdAt),
    role: data.role === "assistant" ? "assistant" : "user",
  }
}

function docToLogEntry(docId: string, data: Record<string, unknown>): LogEntry {
  return {
    id: String(data.id || docId),
    actorId: String(data.actorId || ""),
    actor: String(data.actor || "Teammate"),
    action: String(data.action || "updated"),
    task_id: String(data.task_id || ""),
    note: typeof data.note === "string" && data.note ? data.note : undefined,
    ts: timestampToIso(data.createdAt),
  }
}

export async function createRoomOnServer(user: User, title?: string): Promise<string> {
  const idToken = await user.getIdToken()
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: title?.trim() || "" }),
  })
  const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
  if (!res.ok || !data.code) {
    throw new Error(data.error || "Could not create room")
  }
  return data.code
}

export async function ensureRoomMembership(
  rawCode: string,
  user: User,
  inviteId?: string
): Promise<{ meta: RoomMeta; memberRole: MemberRole }> {
  const code = normalizeRoomCode(rawCode)
  if (!ROOM_CODE_REGEX.test(code)) {
    throw new RoomNotFoundError()
  }

  const roomPath = `rooms/${code}`
  const roomRef = doc(db, "rooms", code)
  const memberPath = `rooms/${code}/members/${user.uid}`
  const memberRef = doc(db, "rooms", code, "members", user.uid)

  let roomSnap
  let memberSnap
  try {
    ;[roomSnap, memberSnap] = await Promise.all([getDoc(roomRef), getDoc(memberRef)])
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, roomPath)
  }

  if (!roomSnap.exists()) {
    throw new RoomNotFoundError()
  }

  const roomData = roomSnap.data()
  const displayName = getUserDisplayName(user)
  const photoURL = (user.photoURL || "").slice(0, 500)
  const meta: RoomMeta = parseRoomMeta(code, roomData)

  if (!memberSnap.exists()) {
    const isOwner = roomData.ownerId === user.uid
    const initialRole: MemberRole = isOwner ? "owner" : "pending"
    const initialStatus: "active" | "pending" = isOwner ? "active" : "pending"
    const cleanInviteId = inviteId?.trim() || ""

    if (!isOwner) {
      const blockedUntilIso = await getBlockedUntilIso(code, user.uid)
      if (blockedUntilIso) {
        throw new RejectedCooldownError(blockedUntilIso)
      }
    }

    if (cleanInviteId && !isOwner) {
      const invitePath = `rooms/${code}/invites/${cleanInviteId}`
      const inviteRef = doc(db, "rooms", code, "invites", cleanInviteId)
      let inviteSnap
      try {
        inviteSnap = await getDoc(inviteRef)
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, invitePath)
      }

      if (!inviteSnap.exists()) {
        throw new InviteExpiredOrLimitError()
      }

      const inviteData = inviteSnap.data()
      const expiresAtIso = timestampToIso(inviteData.expiresAt)
      const expiresAtMs = Date.parse(expiresAtIso)
      const maxUses = typeof inviteData.maxUses === "number" ? inviteData.maxUses : 10
      const usedCount = typeof inviteData.usedCount === "number" ? inviteData.usedCount : 0
      const isValid =
        inviteData.active === true &&
        !Number.isNaN(expiresAtMs) &&
        expiresAtMs > Date.now() &&
        usedCount < maxUses

      if (!isValid) {
        throw new InviteExpiredOrLimitError()
      }

      const batch = writeBatch(db)
      batch.set(memberRef, {
        uid: user.uid,
        displayName,
        photoURL,
        role: initialRole,
        status: initialStatus,
        online: true,
        joinedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      })
      batch.update(inviteRef, {
        usedCount: increment(1),
      })

      try {
        await batch.commit()
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, invitePath)
      }

      return { meta, memberRole: initialRole }
    }

    try {
      await setDoc(memberRef, {
        uid: user.uid,
        displayName,
        photoURL,
        role: initialRole,
        status: initialStatus,
        online: true,
        joinedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      })
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, memberPath)
    }

    return { meta, memberRole: initialRole }
  }

  const existing = memberSnap.data()
  const existingRole: MemberRole =
    existing.role === "owner" ? "owner" : existing.role === "member" ? "member" : "pending"
  const expectedStatus: "active" | "pending" = existingRole === "pending" ? "pending" : "active"
  const lastSeenIso = timestampToIso(existing.lastSeenAt)
  const lastSeenMs = Date.parse(lastSeenIso)
  const recentlyUpdated = !Number.isNaN(lastSeenMs) && Date.now() - lastSeenMs < 30_000
  const unchangedProfile =
    existing.displayName === displayName &&
    existing.photoURL === photoURL &&
    existing.status === expectedStatus &&
    existing.online === true

  if (!(recentlyUpdated && unchangedProfile)) {
    try {
      await updateDoc(memberRef, {
        displayName,
        photoURL,
        status: expectedStatus,
        online: true,
        lastSeenAt: serverTimestamp(),
      })
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, memberPath)
    }
  }

  return { meta, memberRole: existingRole }
}

export async function approvePendingMember(rawCode: string, memberUid: string): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const memberPath = `rooms/${code}/members/${memberUid}`
  try {
    await updateDoc(doc(db, "rooms", code, "members", memberUid), {
      role: "member",
      status: "active",
      lastSeenAt: serverTimestamp(),
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, memberPath)
  }
}

export async function getBlockedUntilIso(rawCode: string, uid: string): Promise<string | null> {
  const code = normalizeRoomCode(rawCode)
  if (!ROOM_CODE_REGEX.test(code) || !uid) return null
  const blockedPath = `rooms/${code}/blocked/${uid}`
  let blockedSnap
  try {
    blockedSnap = await getDoc(doc(db, "rooms", code, "blocked", uid))
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, blockedPath)
  }
  if (!blockedSnap.exists()) return null
  const untilIso = timestampToIso(blockedSnap.data()?.until)
  const untilMs = Date.parse(untilIso)
  if (!Number.isNaN(untilMs) && untilMs > Date.now()) {
    return untilIso
  }
  return null
}

export async function rejectPendingMember(rawCode: string, memberUid: string): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const blockedPath = `rooms/${code}/blocked/${memberUid}`
  const blockedRef = doc(db, "rooms", code, "blocked", memberUid)
  let blockedSnap
  try {
    blockedSnap = await getDoc(blockedRef)
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, blockedPath)
  }

  const prevCount =
    blockedSnap.exists() && typeof blockedSnap.data()?.count === "number"
      ? blockedSnap.data().count
      : 0
  const nextCount = Math.max(1, prevCount + 1)
  const untilDate = computeRejectionUntilDate(Date.now(), nextCount)

  const batch = writeBatch(db)
  batch.delete(doc(db, "rooms", code, "members", memberUid))
  if (blockedSnap.exists()) {
    batch.update(blockedRef, {
      count: nextCount,
      until: Timestamp.fromDate(untilDate),
      updatedAt: serverTimestamp(),
    })
  } else {
    batch.set(blockedRef, {
      uid: memberUid,
      count: nextCount,
      until: Timestamp.fromDate(untilDate),
      updatedAt: serverTimestamp(),
    })
  }

  try {
    await batch.commit()
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, blockedPath)
  }
}

export async function createTemporaryInvite(
  rawCode: string,
  user: User,
  options: { expiresInHours: number; maxUses?: number }
): Promise<{ inviteId: string; url: string }> {
  const code = normalizeRoomCode(rawCode)
  const inviteId = makeClientId("inv")
  const invitePath = `rooms/${code}/invites/${inviteId}`
  const maxUses = Math.max(1, Math.min(1000, Math.floor(options.maxUses ?? 10)))
  const expiresAtDate = new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000)

  try {
    await setDoc(doc(db, "rooms", code, "invites", inviteId), {
      id: inviteId,
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromDate(expiresAtDate),
      maxUses,
      usedCount: 0,
      active: true,
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, invitePath)
  }

  const origin = typeof window !== "undefined" ? window.location.origin : ""
  const url = `${origin}/join?invite=${encodeURIComponent(inviteId)}&room=${encodeURIComponent(code)}`
  return { inviteId, url }
}

export async function revokeInvite(rawCode: string, inviteId: string): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const invitePath = `rooms/${code}/invites/${inviteId}`
  try {
    await updateDoc(doc(db, "rooms", code, "invites", inviteId), {
      active: false,
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, invitePath)
  }
}

export async function validateInviteLink(
  rawCode: string,
  inviteId: string
): Promise<{ valid: boolean; remainingUses?: number; expiresAt?: string }> {
  const code = normalizeRoomCode(rawCode)
  const cleanInviteId = inviteId.trim()
  if (!ROOM_CODE_REGEX.test(code) || !cleanInviteId) {
    return { valid: false }
  }

  const invitePath = `rooms/${code}/invites/${cleanInviteId}`
  let snap
  try {
    snap = await getDoc(doc(db, "rooms", code, "invites", cleanInviteId))
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, invitePath)
  }

  if (!snap.exists()) {
    return { valid: false }
  }

  const data = snap.data()
  const expiresAtIso = timestampToIso(data.expiresAt)
  const expiresAtMs = Date.parse(expiresAtIso)
  const maxUses = typeof data.maxUses === "number" ? data.maxUses : 10
  const usedCount = typeof data.usedCount === "number" ? data.usedCount : 0
  const valid =
    data.active === true &&
    !Number.isNaN(expiresAtMs) &&
    expiresAtMs > Date.now() &&
    usedCount < maxUses

  return {
    valid,
    remainingUses: Math.max(0, maxUses - usedCount),
    expiresAt: expiresAtIso,
  }
}

export function subscribeToPendingRoom(
  rawCode: string,
  uid: string,
  callbacks: {
    onRoom: (meta: RoomMeta) => void
    onMemberRole: (role: MemberRole) => void
    onRejected: () => void
    onNotFound: () => void
    onError: (err: Error) => void
  }
): () => void {
  const code = normalizeRoomCode(rawCode)

  const unsubRoom = onSnapshot(
    doc(db, "rooms", code),
    (snap) => {
      if (!snap.exists()) {
        callbacks.onNotFound()
        return
      }
      const d = snap.data()
      callbacks.onRoom(parseRoomMeta(code, d))
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, `rooms/${code}`)
      } catch (wrapped) {
        callbacks.onError(wrapped as Error)
      }
    }
  )

  const unsubSelfMember = onSnapshot(
    doc(db, "rooms", code, "members", uid),
    (snap) => {
      if (!snap.exists()) {
        callbacks.onRejected()
        return
      }
      const data = snap.data()
      const role: MemberRole =
        data.role === "owner" ? "owner" : data.role === "member" ? "member" : "pending"
      callbacks.onMemberRole(role)
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, `rooms/${code}/members/${uid}`)
      } catch (wrapped) {
        callbacks.onError(wrapped as Error)
      }
    }
  )

  return () => {
    unsubRoom()
    unsubSelfMember()
  }
}

export function subscribeToRoomInvites(
  rawCode: string,
  onInvites: (invites: Invite[]) => void,
  onError: (err: Error) => void
): () => void {
  const code = normalizeRoomCode(rawCode)
  return onSnapshot(
    query(collection(db, "rooms", code, "invites"), orderBy("createdAt", "desc")),
    (snap) => {
      const list: Invite[] = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: String(data.id || d.id),
          createdBy: String(data.createdBy || ""),
          createdAt: timestampToIso(data.createdAt),
          expiresAt: timestampToIso(data.expiresAt),
          maxUses: typeof data.maxUses === "number" ? data.maxUses : 10,
          usedCount: typeof data.usedCount === "number" ? data.usedCount : 0,
          active: Boolean(data.active),
        }
      })
      onInvites(list)
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, `rooms/${code}/invites`)
      } catch (wrapped) {
        onError(wrapped as Error)
      }
    }
  )
}

export async function setMemberPresence(code: string, user: User, online: boolean): Promise<void> {
  const normalized = normalizeRoomCode(code)
  const memberPath = `rooms/${normalized}/members/${user.uid}`
  const memberRef = doc(db, "rooms", normalized, "members", user.uid)
  try {
    await updateDoc(memberRef, {
      displayName: getUserDisplayName(user),
      photoURL: (user.photoURL || "").slice(0, 500),
      online,
      lastSeenAt: serverTimestamp(),
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, memberPath)
  }
}

export async function leaveRoomMembership(code: string, user: User): Promise<void> {
  const normalized = normalizeRoomCode(code)
  const roomPath = `rooms/${normalized}`
  let roomSnap
  try {
    roomSnap = await getDoc(doc(db, "rooms", normalized))
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, roomPath)
  }
  if (roomSnap.exists() && roomSnap.data()?.ownerId === user.uid) {
    throw new Error("Transfer ownership is not available yet")
  }
  const memberPath = `rooms/${normalized}/members/${user.uid}`
  try {
    await deleteDoc(doc(db, "rooms", normalized, "members", user.uid))
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, memberPath)
  }
}

export async function loadOlderMessages(
  rawCode: string,
  cursor: MessageCursor,
  pageSize = OLDER_MESSAGES_PAGE_SIZE
): Promise<{
  messages: Message[]
  nextCursor: MessageCursor | null
  hasMore: boolean
}> {
  const code = normalizeRoomCode(rawCode)
  let snap
  try {
    snap = await getDocs(
      query(
        collection(db, "rooms", code, "messages"),
        orderBy("createdAt", "desc"),
        startAfter(cursor),
        limit(pageSize)
      )
    )
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `rooms/${code}/messages`)
  }
  const descMessages = snap.docs.map((d) => docToMessage(d.id, d.data()))
  return {
    messages: formatMessageWindowAscending(descMessages, pageSize),
    nextCursor: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null,
    hasMore: snap.docs.length === pageSize,
  }
}

export function subscribeToRoom(
  rawCode: string,
  callbacks: {
    onRoom: (meta: RoomMeta) => void
    onMembers: (members: Member[]) => void
    onMessages: (messages: Message[]) => void
    onMessagesMeta?: (meta: { cursor: MessageCursor | null; hasMore: boolean }) => void
    onTasks: (tasks: Task[]) => void
    onLogs: (logs: LogEntry[]) => void
    onFairnessLogs?: (logs: LogEntry[]) => void
    onNotFound: () => void
    onError: (err: Error) => void
  }
): () => void {
  const code = normalizeRoomCode(rawCode)

  const unsubRoom = onSnapshot(
    doc(db, "rooms", code),
    (snap) => {
      if (!snap.exists()) {
        callbacks.onNotFound()
        return
      }
      const d = snap.data()
      callbacks.onRoom(parseRoomMeta(code, d))
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, `rooms/${code}`)
      } catch (wrapped) {
        callbacks.onError(wrapped as Error)
      }
    }
  )

  const unsubMembers = onSnapshot(
    collection(db, "rooms", code, "members"),
    (snap) => {
      const list: Member[] = snap.docs.map((d) => {
        const data = d.data()
        const role: MemberRole =
          data.role === "owner" ? "owner" : data.role === "member" ? "member" : "pending"
        return {
          uid: String(data.uid || d.id),
          name: String(data.displayName || "Teammate"),
          photoURL: String(data.photoURL || ""),
          role,
          status: role === "pending" ? "pending" : "active",
          online: Boolean(data.online),
          lastSeenAt: timestampToIso(data.lastSeenAt),
        }
      })
      const rank = { pending: 0, owner: 1, member: 2 }
      list.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : rank[a.role] - rank[b.role]))
      callbacks.onMembers(list)
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, `rooms/${code}/members`)
      } catch (wrapped) {
        callbacks.onError(wrapped as Error)
      }
    }
  )

  const unsubMessages = onSnapshot(
    query(
      collection(db, "rooms", code, "messages"),
      orderBy("createdAt", "desc"),
      limit(MESSAGE_WINDOW_LIMIT)
    ),
    (snap) => {
      const descList: Message[] = snap.docs.map((d) => docToMessage(d.id, d.data()))
      callbacks.onMessages(formatMessageWindowAscending(descList, MESSAGE_WINDOW_LIMIT))
      callbacks.onMessagesMeta?.({
        cursor: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null,
        hasMore: snap.docs.length === MESSAGE_WINDOW_LIMIT,
      })
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, `rooms/${code}/messages`)
      } catch (wrapped) {
        callbacks.onError(wrapped as Error)
      }
    }
  )

  const unsubTasks = onSnapshot(
    collection(db, "rooms", code, "tasks"),
    (snap) => {
      const list: Task[] = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: String(data.id || d.id),
          title: String(data.title || ""),
          description: typeof data.description === "string" ? data.description : undefined,
          task_type: normalizeTaskType(data.task_type),
          weight: normalizeTaskWeight(data.weight),
          suggested_owner: String(data.suggested_owner || "@Team"),
          owner_uid: String(data.owner_uid || ""),
          due_date: String(data.due_date || "TBD"),
          status: (data.status as TaskStatus) || "todo",
        }
      })
      list.sort((a, b) => {
        const na = Number(a.id.replace(/^t/i, "")) || 0
        const nb = Number(b.id.replace(/^t/i, "")) || 0
        return na - nb
      })
      callbacks.onTasks(list)
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, `rooms/${code}/tasks`)
      } catch (wrapped) {
        callbacks.onError(wrapped as Error)
      }
    }
  )

  const unsubLogs = onSnapshot(
    query(
      collection(db, "rooms", code, "logs"),
      orderBy("createdAt", "desc"),
      limit(ACTIVITY_LOG_LIMIT)
    ),
    (snap) => {
      const list: LogEntry[] = snap.docs.map((d) => docToLogEntry(d.id, d.data()))
      callbacks.onLogs(list)
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, `rooms/${code}/logs`)
      } catch (wrapped) {
        callbacks.onError(wrapped as Error)
      }
    }
  )

  const unsubFairnessLogs = callbacks.onFairnessLogs
    ? onSnapshot(
        query(
          collection(db, "rooms", code, "logs"),
          where("action", "in", ["completed", "started"])
        ),
        (snap) => {
          const list: LogEntry[] = snap.docs.map((d) => docToLogEntry(d.id, d.data()))
          callbacks.onFairnessLogs?.(list)
        },
        (error) => {
          try {
            handleFirestoreError(error, OperationType.LIST, `rooms/${code}/logs`)
          } catch (wrapped) {
            callbacks.onError(wrapped as Error)
          }
        }
      )
    : () => {}

  return () => {
    unsubRoom()
    unsubMembers()
    unsubMessages()
    unsubTasks()
    unsubLogs()
    unsubFairnessLogs()
  }
}

export async function sendChatMessage(
  rawCode: string,
  user: User,
  text: string
): Promise<{ cohortPending: boolean }> {
  const code = normalizeRoomCode(rawCode)
  const cleanText = text.trim().slice(0, 8000)
  if (!cleanText) return { cohortPending: false }

  const msgId = makeClientId("msg")
  const msgPath = `rooms/${code}/messages/${msgId}`
  try {
    await setDoc(doc(db, "rooms", code, "messages", msgId), {
      id: msgId,
      senderId: user.uid,
      triggeredBy: user.uid,
      senderName: getUserDisplayName(user),
      role: "user",
      text: cleanText,
      createdAt: serverTimestamp(),
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, msgPath)
  }

  return { cohortPending: /@cohort\b/i.test(cleanText) }
}

export async function runCohortCommand(
  rawCode: string,
  user: User,
  payload: {
    messageText?: string
    brief?: string
    action?: "extract"
    extractMode?: "merge" | "replace"
    replaceConfirmed?: boolean
  }
): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const idToken = await user.getIdToken()
  const res = await fetch("/api/cohort", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      roomCode: code,
      ...payload,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error || "Cohort command failed")
  }
}

export async function updateRoomAgentAggressiveness(
  rawCode: string,
  level: AgentAggressiveness
): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const roomPath = `rooms/${code}`
  try {
    await updateDoc(doc(db, "rooms", code), {
      agentAggressiveness: level,
      updatedAt: serverTimestamp(),
    })
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, roomPath)
  }
}

export async function triggerCohortPulse(
  rawCode: string,
  user: User
): Promise<{ nudged: boolean; reason?: string }> {
  const code = normalizeRoomCode(rawCode)
  const idToken = await user.getIdToken()
  const res = await fetch("/api/cohort/pulse", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      roomCode: code,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    nudged?: boolean
    reason?: string
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error || "Cohort pulse failed")
  }
  return {
    nudged: Boolean(data.nudged),
    reason: data.reason,
  }
}

export async function generateTaskSandboxWithCohort(
  rawCode: string,
  user: User,
  taskId: string,
  templateMode: SandboxTemplateMode
): Promise<{ templateMode: SandboxTemplateMode; files: SandboxFiles }> {
  const code = normalizeRoomCode(rawCode)
  const idToken = await user.getIdToken()
  const res = await fetch("/api/cohort/sandbox", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roomCode: code, taskId, templateMode }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    templateMode?: SandboxTemplateMode
    files?: SandboxFiles
    error?: string
  }
  if (!res.ok || !data.files) {
    throw new Error(data.error || "Could not generate starter code")
  }
  return {
    templateMode: data.templateMode || templateMode,
    files: data.files,
  }
}

export async function updateTaskStatusFirestore(
  rawCode: string,
  task: Task,
  status: TaskStatus,
  user: User
): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const batch = writeBatch(db)
  const taskRef = doc(db, "rooms", code, "tasks", task.id)
  const logId = makeClientId("log")
  const logRef = doc(db, "rooms", code, "logs", logId)

  const action =
    status === "done"
      ? "completed"
      : status === "blocked"
        ? "blocked"
        : status === "in_progress"
          ? "started"
          : "moved to to do"

  batch.update(taskRef, {
    status,
    updatedBy: user.uid,
    updatedAt: serverTimestamp(),
  })
  batch.set(logRef, {
    id: logId,
    actorId: user.uid,
    triggeredBy: user.uid,
    actor: getUserDisplayName(user),
    action,
    task_id: task.id,
    note: task.title.slice(0, 500),
    createdAt: serverTimestamp(),
  })

  try {
    await batch.commit()
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `rooms/${code}/tasks/${task.id}`)
  }
}

export async function reassignTaskFirestore(
  rawCode: string,
  task: Task,
  member: Member,
  user: User
): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const handle = `@${member.name.split(" ")[0]}`.slice(0, 80)
  const batch = writeBatch(db)
  const taskRef = doc(db, "rooms", code, "tasks", task.id)
  const logId = makeClientId("log")
  const logRef = doc(db, "rooms", code, "logs", logId)

  batch.update(taskRef, {
    suggested_owner: handle,
    owner_uid: member.uid,
    updatedBy: user.uid,
    updatedAt: serverTimestamp(),
  })
  batch.set(logRef, {
    id: logId,
    actorId: user.uid,
    triggeredBy: user.uid,
    actor: getUserDisplayName(user),
    action: "reassigned",
    task_id: task.id,
    note: `Assigned to ${handle}`.slice(0, 500),
    createdAt: serverTimestamp(),
  })

  try {
    await batch.commit()
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `rooms/${code}/tasks/${task.id}`)
  }
}

export type ManualTaskInput = {
  title: string
  description?: string
  task_type: TaskType
  weight?: TaskWeight
  owner_uid: string
  suggested_owner: string
  due_date: string
}

function sanitizeManualTaskInput(input: ManualTaskInput): {
  title: string
  description: string
  task_type: TaskType
  weight: TaskWeight
  owner_uid: string
  suggested_owner: string
  due_date: string
} {
  const title = input.title.trim().slice(0, 200)
  if (!title) {
    throw new Error("Task title is required (1–200 characters).")
  }
  const description = (input.description ?? "").trim().slice(0, 500)
  const task_type = normalizeTaskType(input.task_type) || "general"
  const weight = normalizeTaskWeight(input.weight) ?? 1
  const owner_uid = (input.owner_uid || "").trim().slice(0, 128)
  const suggested_owner = (input.suggested_owner || "@Team").trim().slice(0, 80) || "@Team"
  const due_date = input.due_date.trim().slice(0, 40)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    throw new Error("Please select a valid due date.")
  }
  return {
    title,
    description,
    task_type,
    weight,
    owner_uid,
    suggested_owner,
    due_date,
  }
}

export async function createTaskFirestore(
  rawCode: string,
  input: ManualTaskInput,
  user: User
): Promise<string> {
  const code = normalizeRoomCode(rawCode)
  const clean = sanitizeManualTaskInput(input)
  const roomRef = doc(db, "rooms", code)

  let taskId = ""
  try {
    taskId = await runTransaction(db, async (tx) => {
      const roomSnap = await tx.get(roomRef)
      if (!roomSnap.exists()) {
        throw new RoomNotFoundError()
      }
      const roomData = roomSnap.data()
      const rawNext = roomData.nextTaskNumber
      const nextNum =
        typeof rawNext === "number" && Number.isInteger(rawNext) && rawNext >= 1 ? rawNext : 1
      if (nextNum >= 1000) {
        throw new Error("This room has reached the limit of 999 tasks.")
      }
      tx.update(roomRef, {
        nextTaskNumber: nextNum + 1,
        updatedAt: serverTimestamp(),
      })
      return `t${nextNum}`
    })
  } catch (error) {
    if (error instanceof RoomNotFoundError || (error instanceof Error && error.message.includes("reached the limit"))) {
      throw error
    }
    handleFirestoreError(error, OperationType.WRITE, `rooms/${code}`)
  }

  const batch = writeBatch(db)
  const taskRef = doc(db, "rooms", code, "tasks", taskId)
  const logId = makeClientId("log")
  const logRef = doc(db, "rooms", code, "logs", logId)

  const taskPayload: Record<string, unknown> = {
    id: taskId,
    title: clean.title,
    task_type: clean.task_type,
    weight: clean.weight,
    suggested_owner: clean.suggested_owner,
    owner_uid: clean.owner_uid,
    due_date: clean.due_date,
    status: "todo" as TaskStatus,
    updatedBy: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  if (clean.description) {
    taskPayload.description = clean.description
  }

  batch.set(taskRef, taskPayload)
  batch.set(logRef, {
    id: logId,
    actorId: user.uid,
    triggeredBy: user.uid,
    actor: getUserDisplayName(user),
    action: "created",
    task_id: taskId,
    note: clean.title.slice(0, 500),
    createdAt: serverTimestamp(),
  })

  try {
    await batch.commit()
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `rooms/${code}/tasks/${taskId}`)
  }

  return taskId
}

export async function updateTaskFieldsFirestore(
  rawCode: string,
  task: Task,
  updates: ManualTaskInput,
  user: User
): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const clean = sanitizeManualTaskInput(updates)
  const batch = writeBatch(db)
  const taskRef = doc(db, "rooms", code, "tasks", task.id)
  const logId = makeClientId("log")
  const logRef = doc(db, "rooms", code, "logs", logId)

  batch.update(taskRef, {
    title: clean.title,
    description: clean.description,
    task_type: clean.task_type,
    weight: clean.weight,
    suggested_owner: clean.suggested_owner,
    owner_uid: clean.owner_uid,
    due_date: clean.due_date,
    updatedBy: user.uid,
    updatedAt: serverTimestamp(),
  })
  batch.set(logRef, {
    id: logId,
    actorId: user.uid,
    triggeredBy: user.uid,
    actor: getUserDisplayName(user),
    action: "edited",
    task_id: task.id,
    note: clean.title.slice(0, 500),
    createdAt: serverTimestamp(),
  })

  try {
    await batch.commit()
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `rooms/${code}/tasks/${task.id}`)
  }
}

export async function deleteTaskFirestore(
  rawCode: string,
  task: Task,
  user: User
): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const batch = writeBatch(db)
  const taskRef = doc(db, "rooms", code, "tasks", task.id)
  const logId = makeClientId("log")
  const logRef = doc(db, "rooms", code, "logs", logId)

  batch.delete(taskRef)
  batch.set(logRef, {
    id: logId,
    actorId: user.uid,
    triggeredBy: user.uid,
    actor: getUserDisplayName(user),
    action: "deleted",
    task_id: task.id,
    note: task.title.slice(0, 500),
    createdAt: serverTimestamp(),
  })

  try {
    await batch.commit()
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `rooms/${code}/tasks/${task.id}`)
  }
}


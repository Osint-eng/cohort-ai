import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore"
import type { User } from "firebase/auth"
import { db, handleFirestoreError, OperationType } from "./firebase"

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done"
export type Task = {
  id: string
  title: string
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

export const ROOM_CODE_REGEX = /^[A-Z0-9]{8}$/
export const PRESENCE_TTL_MS = 2 * 60 * 1000

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
  if (error instanceof InviteExpiredOrLimitError) {
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
  const meta: RoomMeta = {
    code,
    title: String(roomData.title || "Project room"),
    summary: String(roomData.summary || ""),
    ownerId: String(roomData.ownerId || ""),
  }

  if (!memberSnap.exists()) {
    const isOwner = roomData.ownerId === user.uid
    const initialRole: MemberRole = isOwner ? "owner" : "pending"
    const initialStatus: "active" | "pending" = isOwner ? "active" : "pending"
    const cleanInviteId = inviteId?.trim() || ""

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

export async function rejectPendingMember(rawCode: string, memberUid: string): Promise<void> {
  const code = normalizeRoomCode(rawCode)
  const memberPath = `rooms/${code}/members/${memberUid}`
  try {
    await deleteDoc(doc(db, "rooms", code, "members", memberUid))
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, memberPath)
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
      callbacks.onRoom({
        code,
        title: String(d.title || "Project room"),
        summary: String(d.summary || ""),
        ownerId: String(d.ownerId || ""),
      })
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
  const memberPath = `rooms/${normalized}/members/${user.uid}`
  try {
    await deleteDoc(doc(db, "rooms", normalized, "members", user.uid))
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, memberPath)
  }
}

export function subscribeToRoom(
  rawCode: string,
  callbacks: {
    onRoom: (meta: RoomMeta) => void
    onMembers: (members: Member[]) => void
    onMessages: (messages: Message[]) => void
    onTasks: (tasks: Task[]) => void
    onLogs: (logs: LogEntry[]) => void
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
      callbacks.onRoom({
        code,
        title: String(d.title || "Project room"),
        summary: String(d.summary || ""),
        ownerId: String(d.ownerId || ""),
      })
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
    query(collection(db, "rooms", code, "messages"), orderBy("createdAt", "asc")),
    (snap) => {
      const list: Message[] = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: String(data.id || d.id),
          senderId: String(data.senderId || ""),
          name: String(data.senderName || "Teammate"),
          text: String(data.text || ""),
          ts: timestampToIso(data.createdAt),
          role: data.role === "assistant" ? "assistant" : "user",
        }
      })
      callbacks.onMessages(list)
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
    query(collection(db, "rooms", code, "logs"), orderBy("createdAt", "desc")),
    (snap) => {
      const list: LogEntry[] = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: String(data.id || d.id),
          actorId: String(data.actorId || ""),
          actor: String(data.actor || "Teammate"),
          action: String(data.action || "updated"),
          task_id: String(data.task_id || ""),
          note: typeof data.note === "string" && data.note ? data.note : undefined,
          ts: timestampToIso(data.createdAt),
        }
      })
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

  return () => {
    unsubRoom()
    unsubMembers()
    unsubMessages()
    unsubTasks()
    unsubLogs()
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
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error || "Cohort command failed")
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

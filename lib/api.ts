import {
  collection,
  deleteDoc,
  doc,
  getDoc,
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
export type Member = {
  uid: string
  name: string
  photoURL: string
  role: "owner" | "member"
  online: boolean
  lastSeenAt: string
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

  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (!raw) return fallback

  // Unwrap structured FirestoreErrorInfo JSON thrown by handleFirestoreError
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
        return "You don’t have permission to update this room. Make sure you’re signed in as a room member."
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
  if (lower.includes("email is not verified") || lower.includes("verified google account")) {
    return "Your Google account email isn’t verified. Please sign in with a verified Google account."
  }
  if (lower.includes("missing or insufficient permissions") || lower.includes("permission-denied")) {
    return "You don’t have permission for that action. Please check your sign-in and room membership."
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

export async function ensureRoomMembership(rawCode: string, user: User): Promise<RoomMeta> {
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

  if (!memberSnap.exists()) {
    const role = roomData.ownerId === user.uid ? "owner" : "member"
    try {
      await setDoc(memberRef, {
        uid: user.uid,
        displayName,
        photoURL,
        role,
        online: true,
        joinedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      })
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, memberPath)
    }
  } else {
    const existing = memberSnap.data()
    const lastSeenIso = timestampToIso(existing.lastSeenAt)
    const lastSeenMs = Date.parse(lastSeenIso)
    const recentlyUpdated = !Number.isNaN(lastSeenMs) && Date.now() - lastSeenMs < 30_000
    const unchangedProfile =
      existing.displayName === displayName &&
      existing.photoURL === photoURL &&
      existing.online === true

    // Avoid redundant write right after server-side room creation or recent heartbeat
    if (!(recentlyUpdated && unchangedProfile)) {
      try {
        await updateDoc(memberRef, {
          displayName,
          photoURL,
          online: true,
          lastSeenAt: serverTimestamp(),
        })
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, memberPath)
      }
    }
  }

  return {
    code,
    title: String(roomData.title || "Project room"),
    summary: String(roomData.summary || ""),
    ownerId: String(roomData.ownerId || ""),
  }
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
        return {
          uid: String(data.uid || d.id),
          name: String(data.displayName || "Teammate"),
          photoURL: String(data.photoURL || ""),
          role: data.role === "owner" ? "owner" : "member",
          online: Boolean(data.online),
          lastSeenAt: timestampToIso(data.lastSeenAt),
        }
      })
      list.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "owner" ? -1 : 1))
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

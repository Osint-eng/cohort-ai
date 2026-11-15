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

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase()
}

export function getUserDisplayName(user: User): string {
  const emailPrefix = user.email ? user.email.split("@")[0] : ""
  return (user.displayName || emailPrefix || "Teammate").trim().slice(0, 80)
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
  let roomSnap
  try {
    roomSnap = await getDoc(roomRef)
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, roomPath)
  }

  if (!roomSnap.exists()) {
    throw new RoomNotFoundError()
  }

  const roomData = roomSnap.data()
  const memberPath = `rooms/${code}/members/${user.uid}`
  const memberRef = doc(db, "rooms", code, "members", user.uid)
  const displayName = getUserDisplayName(user)
  const photoURL = (user.photoURL || "").slice(0, 500)

  let memberSnap
  try {
    memberSnap = await getDoc(memberRef)
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, memberPath)
  }

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
  payload: { messageText?: string; brief?: string; action?: "extract" }
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

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done"
export type Task = { id: string; title: string; suggested_owner: string; due_date: string; status: TaskStatus }
export type LogEntry = { actor: string; action: string; task_id: string; note?: string; ts: string }
export type Message = { name: string; text: string; ts: string; role: "user" | "assistant" }
export type Member = { id: string; name: string; online: boolean }
export type Room = { code: string; title: string; summary: string; messages: Message[]; board: Task[]; log: LogEntry[]; members: Member[] }
export type JoinedRoom = { room: Room; memberId: string }
export class RoomNotFoundError extends Error {
  constructor() { super("Room not found"); this.name = "RoomNotFoundError" }
}
export class NameTakenError extends Error {
  constructor() { super("That name is already taken in this room"); this.name = "NameTakenError" }
}

const now = Date.now()
const mins = (n: number) => new Date(now - n * 60_000).toISOString()
const rooms = new Map<string, Room>()
const createSeedRoom = (code: string, title: string): Room => ({
  code, title, summary: "A campus guide that helps new students find their people, places, and rhythm.",
  members: [{ id: `${code}-member-sam`, name: "Sam", online: true }, { id: `${code}-member-priya`, name: "Priya", online: true }, { id: `${code}-member-alex`, name: "Alex", online: true }],
  messages: [
    { name: "Sam", text: "Hey team! I pulled together the first pass of our project plan.", ts: mins(38), role: "user" },
    { name: "Priya", text: "Love it. I can take the student interview questions.", ts: mins(34), role: "user" },
    { name: "cohort", text: "I’m keeping an eye on the plan. Tag me with @cohort help whenever you need a hand.", ts: mins(32), role: "assistant" },
    { name: "Alex", text: "I’ll start sketching the onboarding flow this afternoon.", ts: mins(25), role: "user" },
  ],
  board: [
    { id: "t1", title: "Interview 5 first-year students", suggested_owner: "@Priya", due_date: "Nov 18", status: "in_progress" },
    { id: "t2", title: "Map the campus welcome journey", suggested_owner: "@Sam", due_date: "Nov 19", status: "todo" },
    { id: "t3", title: "Sketch onboarding screens", suggested_owner: "@Alex", due_date: "Nov 20", status: "in_progress" },
    { id: "t4", title: "Review accessibility requirements", suggested_owner: "@Sam", due_date: "Nov 21", status: "blocked" },
    { id: "t5", title: "Share concept with advisor", suggested_owner: "@Priya", due_date: "Nov 24", status: "done" },
  ],
  log: [
    { actor: "Priya", action: "started", task_id: "t1", note: "Drafting interview questions", ts: mins(12) },
    { actor: "Alex", action: "updated", task_id: "t3", note: "First sketches are underway", ts: mins(46) },
    { actor: "Sam", action: "blocked", task_id: "t4", note: "Waiting on the campus design guide", ts: mins(130) },
    { actor: "Priya", action: "completed", task_id: "t5", note: "Advisor gave us a thumbs up", ts: mins(320) },
  ],
})
const normalizeCode = (code: string) => code.trim().toUpperCase()
const roomStorageKey = (code: string) => `cohort-mock-room:${normalizeCode(code)}`
const persistRoom = (room: Room) => {
  rooms.set(room.code, room)
  if (typeof window !== "undefined") window.localStorage.setItem(roomStorageKey(room.code), JSON.stringify(room))
}
const getRoomOrThrow = (code: string) => {
  const key = normalizeCode(code)
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(roomStorageKey(key))
    if (saved) {
      try {
        const room = JSON.parse(saved) as Room
        rooms.set(key, room)
        return room
      } catch { window.localStorage.removeItem(roomStorageKey(key)) }
    }
  }
  const room = rooms.get(key)
  if (!room) throw new RoomNotFoundError()
  return room
}
const generateRoomCode = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const bytes = new Uint8Array(8)
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}
const createId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `member-${Date.now()}-${Math.random().toString(36).slice(2)}`
export async function createRoom(input: { name: string; title?: string }): Promise<JoinedRoom> {
  await Promise.resolve()
  let code = generateRoomCode()
  while (rooms.has(code) || (typeof window !== "undefined" && window.localStorage.getItem(roomStorageKey(code)))) code = generateRoomCode()
  const room = createSeedRoom(code, input.title?.trim() || "Your project room")
  room.members = []
  const memberId = createId()
  room.members.push({ id: memberId, name: input.name.trim(), online: true })
  persistRoom(room)
  return { room: structuredClone(room), memberId }
}
export async function joinRoom(input: { code: string; name: string; memberId?: string }): Promise<JoinedRoom> {
  await Promise.resolve()
  const room = getRoomOrThrow(input.code)
  const name = input.name.trim()
  const existingMember = input.memberId ? room.members.find((member) => member.id === input.memberId) : undefined
  if (room.members.some((member) => member.id !== existingMember?.id && member.name.toLowerCase() === name.toLowerCase())) throw new NameTakenError()
  if (existingMember) {
    existingMember.name = name
    existingMember.online = true
    persistRoom(room)
    return { room: structuredClone(room), memberId: existingMember.id }
  }
  const memberId = createId()
  room.members.push({ id: memberId, name, online: true })
  persistRoom(room)
  return { room: structuredClone(room), memberId }
}
export async function getRoom(code: string): Promise<Room> { await Promise.resolve(); return structuredClone(getRoomOrThrow(code)) }
export async function leaveRoom(code: string, memberId: string): Promise<void> {
  const room = getRoomOrThrow(code)
  room.members = room.members.filter((member) => member.id !== memberId)
  persistRoom(room)
}
export async function updateTaskStatus(code: string, taskId: string, status: TaskStatus, actor: string): Promise<Room> {
  const room = getRoomOrThrow(code)
  const task = room.board.find((item) => item.id === taskId)
  if (!task) throw new Error(`Task ${taskId} was not found`)
  task.status = status
  const action = status === "done" ? "completed" : status === "blocked" ? "blocked" : status === "in_progress" ? "started" : "moved to to do"
  room.log.unshift({ actor, action, task_id: taskId, note: task.title, ts: new Date().toISOString() })
  persistRoom(room)
  return structuredClone(room)
}
export async function reassignTask(code: string, taskId: string, owner: string, actor: string): Promise<Room> {
  const room = getRoomOrThrow(code)
  const task = room.board.find((item) => item.id === taskId)
  if (!task) throw new Error(`Task ${taskId} was not found`)
  task.suggested_owner = owner.startsWith("@") ? owner : `@${owner}`
  room.log.unshift({ actor, action: "reassigned", task_id: taskId, note: `Assigned to ${task.suggested_owner}`, ts: new Date().toISOString() })
  persistRoom(room)
  return structuredClone(room)
}
export async function postMessage(code: string, name: string, text: string): Promise<Room> {
  const room = getRoomOrThrow(code)
  room.messages.push({ name, text, ts: new Date().toISOString(), role: "user" })
  const command = text.toLowerCase()
  if (command.includes("@cohort help")) room.messages.push({ name: "cohort", text: "Try @cohort sample to seed a board, @cohort extract to open the brief extractor, or @cohort check-in to share a quick team pulse.", ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort sample")) room.messages.push({ name: "cohort", text: "Your sample project board is ready to go. Take a look in the Board tab!", ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort check-in")) room.messages.push({ name: "cohort", text: "Quick check-in: what’s one thing you’ve finished, and what’s one thing you need help with?", ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort list")) room.messages.push({ name: "cohort", text: `There are ${room.board.length} tasks on your board: ${room.board.map((task) => task.id).join(", ")}.`, ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort extract")) room.messages.push({ name: "cohort", text: "Open Extract board above to turn a project brief into a shared plan.", ts: new Date().toISOString(), role: "assistant" })
  persistRoom(room)
  return structuredClone(room)
}
export async function extractBoard(code: string, brief: string): Promise<Room> {
  const room = getRoomOrThrow(code)
  const title = brief.trim().split(/[.!?\n]/)[0]?.slice(0, 72)
  room.summary = title || room.summary
  room.board = [
    { id: "t1", title: "Define the project goals", suggested_owner: "@Sam", due_date: "Nov 18", status: "todo" },
    { id: "t2", title: "Research the audience and context", suggested_owner: "@Priya", due_date: "Nov 20", status: "todo" },
    { id: "t3", title: "Create the first project draft", suggested_owner: "@Alex", due_date: "Nov 24", status: "todo" },
    { id: "t4", title: "Gather feedback from the team", suggested_owner: "@Sam", due_date: "Nov 26", status: "todo" },
    { id: "t5", title: "Present the final project", suggested_owner: "@Priya", due_date: "Dec 02", status: "todo" },
  ]
  room.messages.push({ name: "cohort", text: "I turned your brief into a first-draft board. Your team can update owners and statuses as you go.", ts: new Date().toISOString(), role: "assistant" })
  room.log.unshift({ actor: "cohort", action: "created", task_id: "board", note: "Extracted a project plan from your brief", ts: new Date().toISOString() })
  persistRoom(room)
  return structuredClone(room)
}

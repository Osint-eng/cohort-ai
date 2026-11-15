export type TaskStatus = "todo" | "in_progress" | "blocked" | "done"
export type Task = { id: string; title: string; suggested_owner: string; due_date: string; status: TaskStatus }
export type LogEntry = { actor: string; action: string; task_id: string; note?: string; ts: string }
export type Message = { name: string; text: string; ts: string; role: "user" | "assistant" }
export type Member = { name: string; online: boolean }
export type Room = { code: string; title: string; summary: string; messages: Message[]; board: Task[]; log: LogEntry[]; members: Member[] }

const now = Date.now()
const mins = (n: number) => new Date(now - n * 60_000).toISOString()
const rooms = new Map<string, Room>()
const createSeedRoom = (code: string, title: string): Room => ({
  code, title, summary: "A campus guide that helps new students find their people, places, and rhythm.",
  members: [{ name: "Sam", online: true }, { name: "Priya", online: true }, { name: "Alex", online: true }],
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
const getOrCreate = (code: string) => {
  const key = code.trim().toUpperCase()
  if (!rooms.has(key)) rooms.set(key, createSeedRoom(key, "Campus Connect"))
  return rooms.get(key)!
}
export async function joinRoom(input: { code?: string; name: string; title?: string }): Promise<Room> {
  await Promise.resolve()
  const code = input.code?.trim().toUpperCase() || Math.random().toString(36).slice(2, 8).toUpperCase()
  const room = getOrCreate(code)
  if (input.title?.trim()) room.title = input.title.trim()
  if (!room.members.some((member) => member.name.toLowerCase() === input.name.trim().toLowerCase())) room.members.push({ name: input.name.trim(), online: true })
  return structuredClone(room)
}
export async function getRoom(code: string): Promise<Room> { await Promise.resolve(); return structuredClone(getOrCreate(code)) }
export async function postMessage(code: string, name: string, text: string): Promise<Room> {
  const room = getOrCreate(code)
  room.messages.push({ name, text, ts: new Date().toISOString(), role: "user" })
  const command = text.toLowerCase()
  if (command.includes("@cohort help")) room.messages.push({ name: "cohort", text: "Try @cohort sample to seed a board, @cohort extract to open the brief extractor, or @cohort check-in to share a quick team pulse.", ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort sample")) room.messages.push({ name: "cohort", text: "Your sample project board is ready to go. Take a look in the Board tab!", ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort check-in")) room.messages.push({ name: "cohort", text: "Quick check-in: what’s one thing you’ve finished, and what’s one thing you need help with?", ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort list")) room.messages.push({ name: "cohort", text: `There are ${room.board.length} tasks on your board: ${room.board.map((task) => task.id).join(", ")}.`, ts: new Date().toISOString(), role: "assistant" })
  else if (command.includes("@cohort extract")) room.messages.push({ name: "cohort", text: "Open Extract board above to turn a project brief into a shared plan.", ts: new Date().toISOString(), role: "assistant" })
  return structuredClone(room)
}
export async function extractBoard(code: string, brief: string): Promise<Room> {
  const room = getOrCreate(code)
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
  return structuredClone(room)
}

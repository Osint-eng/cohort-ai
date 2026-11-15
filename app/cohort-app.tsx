"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { createRoom, joinRoom, getRoom, leaveRoom, postMessage, extractBoard, updateTaskStatus, reassignTask, RoomNotFoundError, NameTakenError, type Room, type Task, type TaskStatus, type Member } from "@/lib/api"
import { ArrowDown, ArrowRight, ArrowUpRight, Bot, Check, ChevronDown, CircleHelp, Clipboard, Command, FileText, Hash, LayoutGrid, List, LoaderCircle, LogOut, MessageCircle, Moon, MoreHorizontal, Plus, Send, Share2, Sparkles, Sun, Users, X } from "lucide-react"

const commands = ["@cohort help", "@cohort sample", "@cohort extract", "@cohort check-in", "@cohort list"]
const statusColumns: { id: TaskStatus; label: string; dot: string }[] = [
  { id: "todo", label: "To do", dot: "bg-stone-400" },
  { id: "in_progress", label: "In progress", dot: "bg-orange-500" },
  { id: "blocked", label: "Blocked", dot: "bg-rose-500" },
  { id: "done", label: "Done", dot: "bg-emerald-500" },
]
const initials = (name: string) => name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()
const colors = ["bg-orange-100 text-orange-800", "bg-violet-100 text-violet-800", "bg-sky-100 text-sky-800", "bg-emerald-100 text-emerald-800"]
const relativeTime = (ts: string) => {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000))
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

const memberStorageKey = (code: string) => `cohort-member:${code.toUpperCase()}`
const themeStorageKey = "cohort-theme"

export default function CohortApp({ mode, code = "" }: { mode: "join" | "room"; code?: string }) {
  const router = useRouter()
  const [room, setRoom] = useState<Room | null>(null)
  const [name, setName] = useState("")
  const [roomCode, setRoomCode] = useState("")
  const [projectTitle, setProjectTitle] = useState("")
  const [memberId, setMemberId] = useState("")
  const [isJoined, setIsJoined] = useState(false)
  const [roomLoading, setRoomLoading] = useState(mode === "room")
  const [roomNotFound, setRoomNotFound] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [roomMenuOpen, setRoomMenuOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [activeTab, setActiveTab] = useState("Chat")
  const [view, setView] = useState<"board" | "table">("board")
  const [extractOpen, setExtractOpen] = useState(false)
  const [brief, setBrief] = useState("")
  const [toast, setToast] = useState("")
  const [joining, setJoining] = useState(false)
  const [dark, setDark] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null)

  useEffect(() => {
    const savedTheme = localStorage.getItem(themeStorageKey) === "dark"
    setDark(savedTheme)
    document.documentElement.classList.toggle("dark", savedTheme)
  }, [])
  useEffect(() => {
    if (mode !== "room") return
    let active = true
    getRoom(code).then((loadedRoom) => {
      if (!active) return
      setRoom(loadedRoom)
      const savedMemberId = localStorage.getItem(memberStorageKey(code)) || ""
      const member = loadedRoom.members.find((item) => item.id === savedMemberId)
      if (member) { setMemberId(savedMemberId); setName(member.name); setIsJoined(true) }
      setRoomLoading(false)
    }).catch((cause) => {
      if (!active) return
      if (cause instanceof RoomNotFoundError) setRoomNotFound(true)
      else setError("We couldn’t open that room. Please try again.")
      setRoomLoading(false)
    })
    return () => { active = false }
  }, [mode, code])
  useEffect(() => {
    if (!room || !isJoined) return
    const interval = window.setInterval(async () => {
      try { setRoom(await getRoom(room.code)); setReconnecting(false) }
      catch { setReconnecting(true) }
    }, 3000)
    return () => window.clearInterval(interval)
  }, [room?.code, isJoined])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 2600); return () => window.clearTimeout(timer) }, [toast])

  const enterRoom = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setJoining(true); setError("")
    try {
      const result = mode === "room"
        ? await joinRoom({ code, name: name.trim(), memberId: memberId || undefined })
        : roomCode.trim()
          ? await joinRoom({ code: roomCode.trim(), name: name.trim() })
          : await createRoom({ name: name.trim(), title: projectTitle })
      setRoom(result.room)
      setMemberId(result.memberId)
      setName(name.trim())
      setIsJoined(true)
      localStorage.setItem(memberStorageKey(result.room.code), result.memberId)
      setToast(roomCode.trim() ? "Welcome to your room" : "Your room is ready")
      if (mode === "join") router.push(`/room/${result.room.code}`)
    } catch (cause) {
      if (cause instanceof NameTakenError) setError("That name is already in this room. Try a different display name.")
      else if (cause instanceof RoomNotFoundError) setError("Room not found. Check the code and try again, or create a new room.")
      else setError("We couldn’t open that room. Please try again.")
    } finally { setJoining(false) }
  }
  const send = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!room || !message.trim()) return
    const text = message.trim(); setMessage("")
    try { setRoom(await postMessage(room.code, name || "Sam", text)) }
    catch { setMessage(text); setError("Your message didn’t send. Please try again.") }
  }
  const submitExtract = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!room || !brief.trim()) return
    setRoom(await extractBoard(room.code, brief)); setBrief(""); setExtractOpen(false); setToast("Board extracted from your brief")
  }
  const changeTaskStatus = async (taskId: string, status: TaskStatus) => {
    if (!room) return
    try {
      setRoom(await updateTaskStatus(room.code, taskId, status, name))
      setTaskMenuId(null)
      setToast(status === "done" ? "Task marked done" : status === "blocked" ? "Task marked blocked" : "Task status updated")
    } catch { setError("We couldn’t update that task. Please try again.") }
  }
  const changeTaskOwner = async (taskId: string, owner: string) => {
    if (!room) return
    try {
      setRoom(await reassignTask(room.code, taskId, owner, name))
      setTaskMenuId(null)
      setToast(`Task reassigned to ${owner}`)
    } catch { setError("We couldn’t reassign that task. Please try again.") }
  }
  const copyCode = async () => {
    if (!room) return
    await navigator.clipboard?.writeText(room.code); setCopied(true); setToast("Room code copied"); window.setTimeout(() => setCopied(false), 1800)
  }
  const copyInviteLink = async () => {
    if (!room) return
    await navigator.clipboard?.writeText(new URL(`/room/${room.code}`, window.location.origin).toString())
    setToast("Invite link copied")
  }
  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    localStorage.setItem(themeStorageKey, next ? "dark" : "light")
  }
  const handleLeaveRoom = async () => {
    if (room && memberId) await leaveRoom(room.code, memberId)
    localStorage.removeItem(memberStorageKey(code || room?.code || ""))
    router.push("/join")
  }
  const fillCommand = (command: string) => { if (command === "@cohort extract") setExtractOpen(true); else { setMessage(command); document.getElementById("chat-input")?.focus() } }
  const roomReady = Boolean(room && isJoined)
  const activeRoom = room as Room

  if (roomNotFound) return <main className="room-state-screen"><section className="room-state-card"><div className="room-state-icon"><Hash size={24} /></div><p className="eyebrow">PROJECT ROOM</p><h1>Room not found</h1><p>That invite link may be old or the room code may be incorrect.</p><a className="primary-button" href="/join">Create a new room <ArrowRight size={16} /></a></section></main>
  if (roomLoading) return <main className="room-state-screen"><div className="room-loading" role="status"><LoaderCircle className="spin" size={20} /> Opening room…</div></main>

  return !roomReady ? <main className="join-screen">
    <div className="join-orbit orbit-one" /><div className="join-orbit orbit-two" />
    <header className="join-brand"><a href="/" className="join-brand-link"><span className="brand-mark"><MessageCircle size={21} fill="currentColor" /></span><span>cohort</span></a><button className="join-theme-toggle" onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button></header>
    <section className="join-card">
      <div className="join-illustration"><div className="illus-circle"><Users size={27} /><span className="illus-spark">✦</span></div></div>
      <p className="eyebrow"><span className="live-dot" /> BUILT FOR THE GROUP PROJECT</p>
      <h1>{mode === "room" ? <>Join the<br /><span>conversation.</span></> : <>Big ideas,<br /><span>better together.</span></>}</h1>
      <p className="join-description">{mode === "room" ? `Enter your display name to join ${room?.title ?? "this room"}.` : "Your team’s project manager that lives in the chat."}</p>
      <form onSubmit={enterRoom} className="join-form">
        {mode === "join" && <label>Room code <span className="optional">TO JOIN AN EXISTING ROOM</span><div className="input-wrap"><Hash size={16} /><input value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))} placeholder="Enter an 8-character room code" maxLength={8} autoCapitalize="characters" /></div></label>}
        <label>Your name<div className="input-wrap"><span className="input-avatar">{name ? initials(name) : "?"}</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Priya" /></div></label>
        {mode === "join" && !roomCode.trim() && <label>Project title <span className="optional">OPTIONAL</span><div className="input-wrap"><FileText size={16} /><input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} placeholder="e.g. Campus Connect" /></div></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button join-button" type="submit" disabled={joining}>{joining ? <LoaderCircle className="spin" size={17} /> : <>{mode === "room" || roomCode.trim() ? "Join room" : "Create room"} <ArrowRight size={17} /></>}</button>
      </form>
      <div className="join-foot"><span><span className="avatar-stack"><i>S</i><i>P</i><i>A</i></span> Made for teams like yours</span><span>Made for student teams</span></div>
    </section>
    <p className="join-bottom">Less herding cats. More making things. <span>✳</span></p>
  </main>

  : <main className="workspace-shell">
    <header className="topbar">
      <a className="workspace-brand" href="/" aria-label="Cohort home"><div className="brand-mark"><MessageCircle size={19} fill="currentColor" /></div><span>cohort</span></a>
      <div className="topbar-divider" />
      <div className="room-heading"><span className="room-icon"><Command size={16} /></span><div><strong>{activeRoom.title}</strong><span>Project room</span></div><ChevronDown size={15} className="muted-icon" /></div>
      <div className="topbar-spacer" />
      <button className="room-code" onClick={copyCode} aria-label={`Copy room code ${activeRoom.code}`}><Hash size={14} /> {activeRoom.code} {copied ? <Check size={14} /> : <Clipboard size={13} />}</button>
      <button className="invite-link-button" onClick={copyInviteLink} aria-label="Copy invite link"><Share2 size={14} /><span>Copy invite link</span></button>
      <div className="online-members"><span className="online-dot" /><span>{activeRoom.members.filter((member) => member.online).length} online</span><div className="mini-avatars">{activeRoom.members.slice(0, 3).map((member, index) => <span key={member.name} className={colors[index % colors.length]}>{initials(member.name)}</span>)}</div></div>
      <button className="icon-button theme-button" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={toggleTheme}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
      <div className="room-menu-wrap"><button className="user-menu" aria-label={`Room options for ${name}`} aria-haspopup="menu" aria-expanded={roomMenuOpen} onClick={() => setRoomMenuOpen(!roomMenuOpen)}><span className="user-avatar">{initials(name)}</span><ChevronDown size={14} /></button>{roomMenuOpen && <div className="room-menu" role="menu"><button role="menuitem" onClick={() => void handleLeaveRoom()}><LogOut size={14} /> Leave room</button></div>}</div>
    </header>
    {reconnecting && <div className="reconnect-banner" role="status"><span className="reconnect-dot" /> Reconnecting…</div>}
    <nav className="mobile-tabs" aria-label="Workspace sections">{["Chat", "Board", "Log"].map((tab) => <button key={tab} onClick={() => setActiveTab(tab)} className={activeTab === tab ? "selected" : ""}>{tab === "Chat" ? <MessageCircle size={15} /> : tab === "Board" ? <LayoutGrid size={15} /> : <ArrowUpRight size={15} />}{tab}</button>)}</nav>
    <div className="workspace-grid">
      <section className={`panel chat-panel ${activeTab !== "Chat" ? "mobile-hidden" : ""}`} aria-label="Team chat">
        <div className="panel-header"><div><h2>Chat <span className="channel-label"><Hash size={12} /> general</span></h2></div><button className="icon-button small-icon" aria-label="Chat options"><MoreHorizontal size={19} /></button></div>
        <div className="chat-date"><span /> TODAY <span /></div>
        <div className="messages-list" role="log" aria-label="Team messages" aria-live="polite">{activeRoom.messages.map((item, index) => <MessageRow key={`${item.ts}-${index}`} message={item} />)}</div>
        {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={14} /></button></div>}
        <div className="composer-area"><div className="quick-label"><Sparkles size={12} /> TRY A COMMAND</div><div className="quick-chips">{commands.map((command) => <button key={command} onClick={() => fillCommand(command)}>{command.replace("@cohort ", "")}</button>)}</div><form className="composer" onSubmit={send}><input id="chat-input" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message your team..." aria-label="Message your team" /><button className="send-button" type="submit" aria-label="Send message" disabled={!message.trim()}><Send size={17} /></button></form><p className="composer-hint">Press <kbd>Enter</kbd> to send <span>·</span> <button type="button" onClick={() => setExtractOpen(true)}>Need a hand? <CircleHelp size={12} /></button></p></div>
      </section>
      <section className={`panel board-panel ${activeTab !== "Board" ? "mobile-hidden" : ""}`} aria-label="Project board">
        <div className="panel-header board-header"><div><h2>Board <span className="task-count">{activeRoom.board.length}</span></h2></div><button className="icon-button small-icon" aria-label="Board options"><MoreHorizontal size={19} /></button></div>
        <div className="project-summary"><div className="summary-icon"><Sparkles size={16} /></div><div><span>PROJECT SNAPSHOT</span><p>{activeRoom.summary}</p></div><button aria-label="Edit project summary" onClick={() => setToast("Project snapshot is up to date")}><ArrowUpRight size={14} /></button></div>
        <div className="board-toolbar"><div className="view-toggle" role="group" aria-label="Board display mode"><button onClick={() => setView("board")} className={view === "board" ? "active" : ""} aria-label="Kanban view"><LayoutGrid size={15} /></button><button onClick={() => setView("table")} className={view === "table" ? "active" : ""} aria-label="Table view"><List size={16} /></button></div><button className="extract-button" onClick={() => setExtractOpen(true)}><Plus size={14} /> Extract board</button></div>
        {activeRoom.board.length ? view === "board" ? <div className="kanban-board">{statusColumns.map((column) => { const tasks = activeRoom.board.filter((task) => task.status === column.id); return <div className="kanban-column" key={column.id}><div className="column-heading"><span className={`status-dot ${column.dot}`} /><span>{column.label}</span><span className="column-count">{tasks.length}</span></div><div className="task-stack">{tasks.map((task) => <TaskCard key={task.id} task={task} members={activeRoom.members} menuOpen={taskMenuId === task.id} onToggleMenu={() => setTaskMenuId(taskMenuId === task.id ? null : task.id)} onStatusChange={(status) => void changeTaskStatus(task.id, status)} onReassign={(owner) => void changeTaskOwner(task.id, owner)} />)}{tasks.length === 0 && <div className="column-empty">Nothing here yet</div>}</div></div> })}</div> : <div className="table-wrap"><table><thead><tr><th>ID</th><th>Task</th><th>Owner</th><th>Status</th><th>Due</th></tr></thead><tbody>{activeRoom.board.map((task) => <tr key={task.id}><td><span className="task-id">{task.id}</span></td><td className="table-title">{task.title}</td><td>{task.suggested_owner}</td><td><StatusBadge status={task.status} /></td><td>{task.due_date}</td></tr>)}</tbody></table></div> : <div className="empty-board"><div><LayoutGrid size={22} /></div><strong>No board yet</strong><p>Type <code>@cohort sample</code> or <code>@cohort extract</code> in the chat to get started.</p><button onClick={() => setExtractOpen(true)}><Plus size={14} /> Extract from a brief</button></div>}
        <div className="board-footer"><span><span className="live-dot" /> Changes sync automatically</span><button onClick={() => setToast("You’re all caught up")}>Last updated just now <ArrowDown size={13} /></button></div>
      </section>
      <aside className={`panel activity-panel ${activeTab !== "Log" ? "mobile-hidden" : ""}`} aria-label="Contribution log and members">
        <div className="panel-header"><div><h2>Activity <span className="activity-live">LIVE</span></h2></div><button className="icon-button small-icon" aria-label="Activity options"><MoreHorizontal size={19} /></button></div>
        <div className="activity-feed">{activeRoom.log.map((entry, index) => <div key={`${entry.ts}-${index}`} className="timeline-item"><div className={`timeline-avatar ${colors[activeRoom.members.findIndex((member) => member.name === entry.actor) % colors.length] || colors[0]}`}>{entry.actor === "cohort" ? <Bot size={14} /> : initials(entry.actor)}</div><div className="timeline-copy"><p><strong>{entry.actor}</strong> {entry.action} <span className="task-id">{entry.task_id}</span></p>{entry.note && <p className="timeline-note">“{entry.note}”</p>}<time>{relativeTime(entry.ts)}</time></div></div>)}{activeRoom.log.length === 0 && <p className="no-activity">Team activity will show up here.</p>}</div>
        <div className="members-section"><div className="members-heading"><div><h3>Members <span>{activeRoom.members.length}</span></h3></div><button onClick={() => setToast("Share your room code: " + activeRoom.code)} aria-label="Invite a teammate"><Plus size={15} /></button></div><div className="member-list">{activeRoom.members.map((member, index) => <div className="member-row" key={member.name}><span className={`member-avatar ${colors[index % colors.length]}`}>{initials(member.name)}</span><span className="member-name">{member.name}{member.name === name && <small>you</small>}</span><span className={`member-status ${member.online ? "online" : ""}`}>{member.online ? "online" : "away"}</span></div>)}</div><button className="invite-link" onClick={copyCode}><Users size={15} /> Invite your teammates <ArrowRight size={14} /></button></div>
        <div className="agent-card"><div className="agent-icon"><Bot size={17} /></div><div><strong>Your teammate, Cohort</strong><p>Here to keep the project moving.</p></div><span className="agent-spark">✳</span></div>
      </aside>
    </div>
    {extractOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExtractOpen(false) }}><section className="extract-dialog" role="dialog" aria-modal="true" aria-labelledby="extract-title"><button className="dialog-close" onClick={() => setExtractOpen(false)} aria-label="Close dialog"><X size={18} /></button><div className="dialog-icon"><Sparkles size={20} /></div><p className="section-kicker">FROM BRIEF TO BOARD</p><h2 id="extract-title">Let&apos;s make a game plan.</h2><p className="dialog-description">Paste your assignment or project brief. Cohort will turn it into a first-draft task board for your team.</p><form onSubmit={submitExtract}><label htmlFor="brief-input">Your project brief</label><textarea id="brief-input" autoFocus value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="Paste your assignment, project goals, or a few notes to get started..." required /><div className="dialog-footer"><span><Sparkles size={13} /> You can edit everything later</span><button className="primary-button" type="submit" disabled={!brief.trim()}>Build my board <ArrowRight size={16} /></button></div></form></section></div>}
    {toast && <div className="toast-message" role="status"><span className="toast-check"><Check size={14} /></span>{toast}<button onClick={() => setToast("")} aria-label="Dismiss notification"><X size={14} /></button></div>}
  </main>
}

function MessageRow({ message }: { message: Room["messages"][number] }) {
  const isBot = message.role === "assistant"
  const palette = message.name === "Priya" ? colors[1] : message.name === "Alex" ? colors[2] : colors[0]
  return <article className={`message-row ${isBot ? "bot-message" : ""}`}><span className={`message-avatar ${isBot ? "bot-avatar" : palette}`}>{isBot ? <Bot size={15} /> : initials(message.name)}</span><div className="message-content"><div className="message-meta"><strong>{isBot ? "@cohort" : message.name}</strong>{isBot && <span className="bot-label">TEAM BOT</span>}<time>{relativeTime(message.ts)}</time></div><div className="message-bubble">{message.text}</div></div></article>
}
function StatusBadge({ status }: { status: TaskStatus }) { const label = status === "in_progress" ? "In progress" : status === "todo" ? "To do" : status === "done" ? "Done" : "Blocked"; return <span className={`status-badge status-${status}`}><span />{label}</span> }
function TaskCard({ task, members, menuOpen, onToggleMenu, onStatusChange, onReassign }: { task: Task; members: Member[]; menuOpen: boolean; onToggleMenu: () => void; onStatusChange: (status: TaskStatus) => void; onReassign: (owner: string) => void }) {
  return <article className="task-card"><div className="task-card-top"><span className="task-id">{task.id}</span><button aria-label={`Options for ${task.title}`} aria-expanded={menuOpen} aria-haspopup="true" onClick={onToggleMenu}><MoreHorizontal size={15} /></button></div><h3>{task.title}</h3><div className="task-card-bottom"><span className="task-owner"><span className="owner-avatar">{initials(task.suggested_owner.slice(1))}</span>{task.suggested_owner}</span><span className="due-date"><ArrowUpRight size={12} />{task.due_date}</span></div>{menuOpen && <div className="task-actions" role="group" aria-label={`Actions for ${task.title}`} onKeyDown={(event) => { if (event.key === "Escape") onToggleMenu() }}><button onClick={() => onStatusChange("done")} disabled={task.status === "done"}><Check size={13} />Mark done</button><button onClick={() => onStatusChange("blocked")} disabled={task.status === "blocked"}><X size={13} />Mark blocked</button><div className="task-action-divider" /><span>Reassign to</span>{members.map((member) => <button key={member.name} onClick={() => onReassign(member.name)} disabled={task.suggested_owner.toLowerCase() === `@${member.name}`.toLowerCase()}><span className="owner-avatar">{initials(member.name)}</span>{member.name}</button>)}</div>}</article>
}

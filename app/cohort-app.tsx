"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth"
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Clipboard,
  Command,
  FileText,
  Hash,
  LayoutGrid,
  List,
  LoaderCircle,
  LogIn,
  LogOut,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Plus,
  Send,
  Share2,
  Sparkles,
  Sun,
  Users,
  X,
} from "lucide-react"
import { auth, googleProvider, validateFirestoreConnection } from "@/lib/firebase"
import {
  createRoomOnServer,
  ensureRoomMembership,
  formatMemberLastSeen,
  getFriendlyErrorMessage,
  getUserDisplayName,
  isMemberOnline,
  leaveRoomMembership,
  normalizeRoomCode,
  reassignTaskFirestore,
  ROOM_CODE_REGEX,
  RoomNotFoundError,
  runCohortCommand,
  sendChatMessage,
  setMemberPresence,
  subscribeToRoom,
  suggestDefaultRoomTitle,
  updateTaskStatusFirestore,
  type LogEntry,
  type Member,
  type Message,
  type RoomMeta,
  type Task,
  type TaskStatus,
} from "@/lib/api"

const commands = [
  "@cohort help",
  "@cohort extract",
  "@cohort check-in",
  "@cohort mark t1 complete",
  "@cohort mark t2 blocked because ",
  "@cohort list",
]

const statusColumns: { id: TaskStatus; label: string; dot: string }[] = [
  { id: "todo", label: "To do", dot: "bg-stone-400" },
  { id: "in_progress", label: "In progress", dot: "bg-orange-500" },
  { id: "blocked", label: "Blocked", dot: "bg-rose-500" },
  { id: "done", label: "Done", dot: "bg-emerald-500" },
]

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?"

const colors = [
  "bg-orange-100 text-orange-800",
  "bg-violet-100 text-violet-800",
  "bg-sky-100 text-sky-800",
  "bg-emerald-100 text-emerald-800",
]

const colorIndexForId = (id: string) => {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % colors.length
}

const relativeTime = (ts: string) => {
  const parsed = new Date(ts).getTime()
  if (Number.isNaN(parsed)) return "now"
  const mins = Math.max(0, Math.floor((Date.now() - parsed) / 60000))
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

const themeStorageKey = "cohort-theme"

export default function CohortApp({ mode, code = "" }: { mode: "join" | "room"; code?: string }) {
  const router = useRouter()
  const normalizedRouteCode = normalizeRoomCode(code)

  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [signingIn, setSigningIn] = useState(false)

  const [roomMeta, setRoomMeta] = useState<RoomMeta | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])

  const [roomCode, setRoomCode] = useState("")
  const [projectTitle, setProjectTitle] = useState("")
  const [isJoined, setIsJoined] = useState(false)
  const [roomLoading, setRoomLoading] = useState(mode === "room")
  const [roomNotFound, setRoomNotFound] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [roomMenuOpen, setRoomMenuOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [cohortThinking, setCohortThinking] = useState(false)
  const [activeTab, setActiveTab] = useState("Chat")
  const [view, setView] = useState<"board" | "table">("board")
  const [extractOpen, setExtractOpen] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractMode, setExtractMode] = useState<"merge" | "replace">("merge")
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)
  const [brief, setBrief] = useState("")
  const [toast, setToast] = useState("")
  const [toastTone, setToastTone] = useState<"success" | "error">("success")
  const [joining, setJoining] = useState(false)
  const [dark, setDark] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null)
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const leftRoomRef = useRef(false)

  const showToast = (msg: string, tone: "success" | "error" = "success") => {
    setToastTone(tone)
    setToast(msg)
  }

  useEffect(() => {
    const savedTheme = localStorage.getItem(themeStorageKey) === "dark"
    setDark(savedTheme)
    document.documentElement.classList.toggle("dark", savedTheme)
    void validateFirestoreConnection()
  }, [])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setAuthLoading(false)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (mode !== "room") return

    if (!ROOM_CODE_REGEX.test(normalizedRouteCode)) {
      setRoomNotFound(true)
      setRoomLoading(false)
      return
    }

    if (authLoading) {
      setRoomLoading(true)
      return
    }

    if (!user) {
      setIsJoined(false)
      setRoomLoading(false)
      return
    }

    if (user.emailVerified === false) {
      setIsJoined(false)
      setRoomLoading(false)
      return
    }

    let active = true
    let unsubRoom: (() => void) | null = null
    leftRoomRef.current = false
    setRoomLoading(true)
    setRoomNotFound(false)
    setError("")

    ensureRoomMembership(normalizedRouteCode, user)
      .then((meta) => {
        if (!active) return
        setRoomMeta(meta)
        setIsJoined(true)
        setRoomLoading(false)

        unsubRoom = subscribeToRoom(normalizedRouteCode, {
          onRoom: (nextMeta) => {
            if (!active) return
            setRoomMeta(nextMeta)
            setReconnecting(false)
          },
          onMembers: (nextMembers) => {
            if (!active) return
            setMembers(nextMembers)
          },
          onMessages: (nextMessages) => {
            if (!active) return
            setMessages(nextMessages)
          },
          onTasks: (nextTasks) => {
            if (!active) return
            setTasks(nextTasks)
          },
          onLogs: (nextLogs) => {
            if (!active) return
            setLogs(nextLogs)
          },
          onNotFound: () => {
            if (!active) return
            setRoomNotFound(true)
            setIsJoined(false)
          },
          onError: () => {
            if (!active) return
            setReconnecting(true)
          },
        })
      })
      .catch((cause) => {
        if (!active) return
        if (cause instanceof RoomNotFoundError) {
          setRoomNotFound(true)
        } else {
          setError(getFriendlyErrorMessage(cause, "We couldn’t open that room. Please try again."))
        }
        setRoomLoading(false)
      })

    // Periodic heartbeat + visibility sync so presence expires cleanly via lastSeenAt TTL
    const heartbeatId = window.setInterval(() => {
      setNowMs(Date.now())
      if (document.visibilityState === "visible" && !leftRoomRef.current) {
        void setMemberPresence(normalizedRouteCode, user, true).catch(() => {})
      }
    }, 45_000)

    const handleVisibilityChange = () => {
      setNowMs(Date.now())
      if (leftRoomRef.current) return
      const visible = document.visibilityState === "visible"
      void setMemberPresence(normalizedRouteCode, user, visible).catch(() => {})
    }

    const handleBeforeUnload = () => {
      if (!leftRoomRef.current) {
        void setMemberPresence(normalizedRouteCode, user, false).catch(() => {})
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("beforeunload", handleBeforeUnload)

    return () => {
      active = false
      window.clearInterval(heartbeatId)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("beforeunload", handleBeforeUnload)
      if (unsubRoom) unsubRoom()
      if (!leftRoomRef.current) {
        void setMemberPresence(normalizedRouteCode, user, false).catch(() => {})
      }
    }
  }, [mode, normalizedRouteCode, authLoading, user])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(""), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, cohortThinking])

  const handleGoogleSignIn = async () => {
    setSigningIn(true)
    setError("")
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (cause) {
      const code = (cause as { code?: string })?.code || ""
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // User dismissed popup; no alarming error needed.
      } else if (code === "auth/popup-blocked") {
        setError("Your browser blocked the sign-in popup. Please allow popups for this site and try again.")
      } else {
        setError("Google sign-in didn’t complete. Please try again.")
      }
    } finally {
      setSigningIn(false)
    }
  }

  const handleSignOut = async () => {
    setRoomMenuOpen(false)
    setError("")
    try {
      if (mode === "room" && roomMeta && user) {
        leftRoomRef.current = true
        await setMemberPresence(roomMeta.code, user, false).catch(() => {})
      }
      await signOut(auth)
      setRoomMeta(null)
      setIsJoined(false)
      if (mode === "room") router.push("/join")
    } catch {
      setError("Could not sign out right now. Please try again.")
    }
  }

  const enterRoom = async (event: React.FormEvent) => {
    event.preventDefault()
    if (joining) return
    if (!user) {
      await handleGoogleSignIn()
      return
    }
    if (user.emailVerified === false) {
      const msg = "Please sign in with a verified Google account email to continue."
      setError(msg)
      showToast(msg, "error")
      return
    }

    const trimmedCode = normalizeRoomCode(roomCode)
    const trimmedTitle = projectTitle.trim()

    if (trimmedCode && !ROOM_CODE_REGEX.test(trimmedCode)) {
      const msg = "Enter a valid 8-character room code or leave it blank to create a new room."
      setError(msg)
      showToast(msg, "error")
      return
    }

    if (!trimmedCode && trimmedTitle.length > 0 && trimmedTitle.length < 3) {
      const msg = "Project title must be at least 3 characters, or leave blank for an automatic title."
      setError(msg)
      showToast(msg, "error")
      return
    }

    setJoining(true)
    setError("")

    try {
      if (trimmedCode) {
        await ensureRoomMembership(trimmedCode, user)
        showToast("Welcome to your room")
        router.push(`/room/${trimmedCode}`)
      } else {
        const finalTitle = trimmedTitle || suggestDefaultRoomTitle(user)
        const createdCode = await createRoomOnServer(user, finalTitle)
        showToast("Your room is ready")
        router.push(`/room/${createdCode}`)
      }
    } catch (cause) {
      const friendly =
        cause instanceof RoomNotFoundError
          ? "Room not found. Check the code and try again, or create a new room."
          : getFriendlyErrorMessage(cause, "We couldn’t open that room. Please try again.")
      setError(friendly)
      showToast(friendly, "error")
      setJoining(false)
    }
  }

  const send = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!roomMeta || !user || !message.trim()) return
    const text = message.trim()
    setMessage("")
    setError("")
    try {
      const { cohortPending } = await sendChatMessage(roomMeta.code, user, text)
      if (cohortPending) {
        setCohortThinking(true)
        try {
          await runCohortCommand(roomMeta.code, user, { messageText: text })
        } finally {
          setCohortThinking(false)
        }
      }
    } catch (cause) {
      setCohortThinking(false)
      setMessage(text)
      const friendly = getFriendlyErrorMessage(cause, "Your message didn’t send. Please try again.")
      setError(friendly)
      showToast(friendly, "error")
    }
  }

  const openExtractModal = () => {
    setError("")
    setExtractMode("merge")
    setReplaceConfirmed(false)
    setExtractOpen(true)
  }

  const submitExtract = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!roomMeta || !user || !brief.trim() || extracting) return
    if (tasks.length > 0 && extractMode === "replace" && !replaceConfirmed) {
      setError("Please confirm replacing existing tasks or switch to Merge mode.")
      return
    }
    setExtracting(true)
    setError("")
    try {
      const hadTasks = tasks.length > 0
      await runCohortCommand(roomMeta.code, user, {
        brief: brief.trim(),
        action: "extract",
        extractMode: hadTasks ? extractMode : "replace",
        replaceConfirmed: hadTasks && extractMode === "replace" ? replaceConfirmed : false,
      })
      setBrief("")
      setReplaceConfirmed(false)
      setExtractMode("merge")
      setExtractOpen(false)
      showToast(
        hadTasks && extractMode === "merge"
          ? "New tasks merged into your board"
          : "Board extracted from your brief"
      )
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not extract tasks from your brief.")
      setError(friendly)
      showToast(friendly, "error")
    } finally {
      setExtracting(false)
    }
  }

  const changeTaskStatus = async (task: Task, status: TaskStatus) => {
    if (!roomMeta || !user) return
    setUpdatingTaskId(task.id)
    setError("")
    try {
      await updateTaskStatusFirestore(roomMeta.code, task, status, user)
      setTaskMenuId(null)
      showToast(
        status === "done"
          ? "Task marked done"
          : status === "blocked"
            ? "Task marked blocked"
            : "Task status updated"
      )
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "We couldn’t update that task. Please try again.")
      setError(friendly)
      showToast(friendly, "error")
    } finally {
      setUpdatingTaskId(null)
    }
  }

  const changeTaskOwner = async (task: Task, member: Member) => {
    if (!roomMeta || !user) return
    setUpdatingTaskId(task.id)
    setError("")
    try {
      await reassignTaskFirestore(roomMeta.code, task, member, user)
      setTaskMenuId(null)
      showToast(`Task reassigned to ${member.name}`)
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "We couldn’t reassign that task. Please try again.")
      setError(friendly)
      showToast(friendly, "error")
    } finally {
      setUpdatingTaskId(null)
    }
  }

  const copyCode = async () => {
    if (!roomMeta) return
    await navigator.clipboard?.writeText(roomMeta.code)
    setCopied(true)
    showToast("Room code copied")
    window.setTimeout(() => setCopied(false), 1800)
  }

  const copyInviteLink = async () => {
    if (!roomMeta) return
    await navigator.clipboard?.writeText(new URL(`/room/${roomMeta.code}`, window.location.origin).toString())
    showToast("Invite link copied")
  }

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    localStorage.setItem(themeStorageKey, next ? "dark" : "light")
    document.documentElement.classList.toggle("dark", next)
  }

  const handleLeaveRoom = async () => {
    setRoomMenuOpen(false)
    leftRoomRef.current = true
    if (roomMeta && user) {
      await leaveRoomMembership(roomMeta.code, user).catch(() => {})
    }
    router.push("/join")
  }

  const fillCommand = (command: string) => {
    if (command === "@cohort extract") {
      openExtractModal()
    } else {
      setMessage(command)
      document.getElementById("chat-input")?.focus()
    }
  }

  if (roomNotFound) {
    return (
      <main className="room-state-screen">
        <section className="room-state-card">
          <div className="room-state-icon">
            <Hash size={24} />
          </div>
          <p className="eyebrow">PROJECT ROOM</p>
          <h1>Room not found</h1>
          <p>That invite link may be old or the room code may be incorrect.</p>
          <a className="primary-button" href="/join">
            Create or join a room <ArrowRight size={16} />
          </a>
        </section>
      </main>
    )
  }

  if (authLoading || (mode === "room" && user && roomLoading)) {
    return (
      <main className="room-state-screen">
        <div className="room-loading" role="status">
          <LoaderCircle className="spin" size={20} /> {authLoading ? "Checking session…" : "Opening room…"}
        </div>
      </main>
    )
  }

  const roomReady = Boolean(mode === "room" && user && roomMeta && isJoined)
  const currentUserName = user ? getUserDisplayName(user) : ""

  if (!roomReady) {
    return (
      <main className="join-screen">
        <div className="join-orbit orbit-one" />
        <div className="join-orbit orbit-two" />
        <header className="join-brand">
          <a href="/" className="join-brand-link">
            <span className="brand-mark">
              <MessageCircle size={21} fill="currentColor" />
            </span>
            <span>cohort</span>
          </a>
          <button
            className="join-theme-toggle"
            onClick={toggleTheme}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </header>

        <section className="join-card">
          <div className="join-illustration">
            <div className="illus-circle">
              <Users size={27} />
              <span className="illus-spark">✦</span>
            </div>
          </div>
          <p className="eyebrow">
            <span className="live-dot" /> BUILT FOR THE GROUP PROJECT
          </p>
          <h1>
            {mode === "room" ? (
              <>
                Join the
                <br />
                <span>conversation.</span>
              </>
            ) : (
              <>
                Big ideas,
                <br />
                <span>better together.</span>
              </>
            )}
          </h1>
          <p className="join-description">
            {mode === "room"
              ? `Sign in with Google to enter room ${normalizedRouteCode}.`
              : user
                ? "Create a new room or enter an 8-character invite code."
                : "Sign in with Google to start a room or join your team."}
          </p>

          {!user ? (
            <div className="join-form">
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button
                type="button"
                className="primary-button join-button google-signin-btn"
                onClick={() => void handleGoogleSignIn()}
                disabled={signingIn}
              >
                {signingIn ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <>
                    <LogIn size={17} /> Continue with Google <ArrowRight size={17} />
                  </>
                )}
              </button>
              {mode === "room" && (
                <a className="secondary-join-link" href="/join">
                  Go to room switcher instead
                </a>
              )}
            </div>
          ) : (
            <form onSubmit={enterRoom} className="join-form">
              <div className="signed-in-bar">
                <div className="signed-in-identity">
                  <span className="input-avatar">
                    {user.photoURL ? (
                      <img
                        src={user.photoURL}
                        alt={currentUserName}
                        className="avatar-img"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      initials(currentUserName)
                    )}
                  </span>
                  <div className="signed-in-copy">
                    <strong>{currentUserName}</strong>
                    <span>Signed in with Google</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="signout-chip"
                  onClick={() => void handleSignOut()}
                >
                  Sign out
                </button>
              </div>

              {user.emailVerified === false && (
                <div className="verified-warning" role="alert">
                  <strong>Verified Google email required</strong>
                  Your account ({user.email || "Google user"}) does not report a verified email. Please sign in with a verified Google account to create or join rooms.
                </div>
              )}

              {mode === "join" && (
                <label>
                  Room code <span className="optional">TO JOIN AN EXISTING ROOM</span>
                  <div className="input-wrap">
                    <Hash size={16} />
                    <input
                      value={roomCode}
                      onChange={(event) =>
                        setRoomCode(
                          event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9]/g, "")
                            .slice(0, 8)
                        )
                      }
                      placeholder="Leave blank to create, or enter 8-char code"
                      maxLength={8}
                      autoCapitalize="characters"
                      disabled={joining}
                    />
                  </div>
                </label>
              )}

              {mode === "join" && !roomCode.trim() && (
                <label>
                  Project title <span className="optional">AUTO-NAMED IF BLANK</span>
                  <div className="input-wrap">
                    <FileText size={16} />
                    <input
                      value={projectTitle}
                      onChange={(event) => setProjectTitle(event.target.value)}
                      placeholder={`e.g. ${suggestDefaultRoomTitle(user)}`}
                      maxLength={120}
                      disabled={joining}
                    />
                  </div>
                </label>
              )}

              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}

              <button
                className="primary-button join-button"
                type="submit"
                disabled={joining || user.emailVerified === false}
              >
                {joining ? (
                  <>
                    <LoaderCircle className="spin" size={17} />
                    {roomCode.trim() ? "Joining room…" : "Creating room…"}
                  </>
                ) : (
                  <>
                    {roomCode.trim() ? "Join room" : "Create room"} <ArrowRight size={17} />
                  </>
                )}
              </button>
            </form>
          )}

          <div className="join-foot">
            <span>
              <span className="avatar-stack">
                <i>S</i>
                <i>P</i>
                <i>A</i>
              </span>{" "}
              Made for teams like yours
            </span>
            <span>Student group workspace</span>
          </div>
        </section>
        <p className="join-bottom">
          Less herding cats. More making things. <span>✳</span>
        </p>
      </main>
    )
  }

  const activeRoom = roomMeta as RoomMeta

  return (
    <main className="workspace-shell">
      <header className="topbar">
        <a className="workspace-brand" href="/" aria-label="Cohort home">
          <div className="brand-mark">
            <MessageCircle size={19} fill="currentColor" />
          </div>
          <span>cohort</span>
        </a>
        <div className="topbar-divider" />
        <div className="room-heading">
          <span className="room-icon">
            <Command size={16} />
          </span>
          <div>
            <strong>{activeRoom.title}</strong>
            <span>Project room</span>
          </div>
          <ChevronDown size={15} className="muted-icon" />
        </div>
        <div className="topbar-spacer" />
        <button
          className="room-code"
          onClick={copyCode}
          aria-label={`Copy room code ${activeRoom.code}`}
        >
          <Hash size={14} /> {activeRoom.code} {copied ? <Check size={14} /> : <Clipboard size={13} />}
        </button>
        <button className="invite-link-button" onClick={copyInviteLink} aria-label="Copy invite link">
          <Share2 size={14} />
          <span>Copy invite link</span>
        </button>
        <div className="online-members">
          <span className="online-dot" />
          <span>{members.filter((member) => isMemberOnline(member, nowMs)).length} online</span>
          <div className="mini-avatars">
            {members.slice(0, 3).map((member) => (
              <span
                key={member.uid}
                className={colors[colorIndexForId(member.uid)]}
                title={member.name}
              >
                {member.photoURL ? (
                  <img
                    src={member.photoURL}
                    alt={member.name}
                    className="avatar-img"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  initials(member.name)
                )}
              </span>
            ))}
          </div>
        </div>
        <button
          className="icon-button theme-button"
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggleTheme}
        >
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <div className="room-menu-wrap">
          <button
            className="user-menu"
            aria-label={`Room options for ${currentUserName}`}
            aria-haspopup="menu"
            aria-expanded={roomMenuOpen}
            onClick={() => setRoomMenuOpen(!roomMenuOpen)}
          >
            <span className="user-avatar">
              {user?.photoURL ? (
                <img
                  src={user.photoURL}
                  alt={currentUserName}
                  className="avatar-img"
                  referrerPolicy="no-referrer"
                />
              ) : (
                initials(currentUserName)
              )}
            </span>
            <ChevronDown size={14} />
          </button>
          {roomMenuOpen && (
            <div className="room-menu" role="menu">
              <div className="room-menu-user">
                <strong>{currentUserName}</strong>
                <span>Google account</span>
              </div>
              <button role="menuitem" onClick={() => void handleLeaveRoom()}>
                <LogOut size={14} /> Leave room
              </button>
              <button role="menuitem" onClick={() => void handleSignOut()}>
                <X size={14} /> Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {reconnecting && (
        <div className="reconnect-banner" role="status">
          <span className="reconnect-dot" /> Syncing room…
        </div>
      )}

      <nav className="mobile-tabs" aria-label="Workspace sections">
        {["Chat", "Board", "Log"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={activeTab === tab ? "selected" : ""}
          >
            {tab === "Chat" ? (
              <MessageCircle size={15} />
            ) : tab === "Board" ? (
              <LayoutGrid size={15} />
            ) : (
              <ArrowUpRight size={15} />
            )}
            {tab}
          </button>
        ))}
      </nav>

      <div className="workspace-grid">
        <section
          className={`panel chat-panel ${activeTab !== "Chat" ? "mobile-hidden" : ""}`}
          aria-label="Team chat"
        >
          <div className="panel-header">
            <div>
              <h2>
                Chat{" "}
                <span className="channel-label">
                  <Hash size={12} /> general
                </span>
              </h2>
            </div>
            <button
              className="icon-button small-icon"
              aria-label="Extract board from brief"
              onClick={openExtractModal}
            >
              <Sparkles size={16} />
            </button>
          </div>
          <div className="chat-date">
            <span /> TODAY <span />
          </div>
          <div
            ref={messagesContainerRef}
            className="messages-list"
            role="log"
            aria-label="Team messages"
            aria-live="polite"
          >
            {messages.map((item) => {
              const senderMember = members.find((m) => m.uid === item.senderId)
              return <MessageRow key={item.id} message={item} member={senderMember} />
            })}
            {cohortThinking && (
              <div className="cohort-thinking" role="status">
                <LoaderCircle className="spin" size={13} />
                <span>@cohort is thinking…</span>
              </div>
            )}
          </div>
          {error && (
            <div className="inline-error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="composer-area">
            <div className="quick-label">
              <Sparkles size={12} /> TRY A COMMAND
            </div>
            <div className="quick-chips">
              {commands.map((command) => (
                <button key={command} type="button" onClick={() => fillCommand(command)}>
                  {command.replace("@cohort ", "")}
                </button>
              ))}
            </div>
            <form className="composer" onSubmit={send}>
              <input
                id="chat-input"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Message your team or tag @cohort..."
                aria-label="Message your team"
              />
              <button
                className="send-button"
                type="submit"
                aria-label="Send message"
                disabled={!message.trim() || cohortThinking}
              >
                <Send size={17} />
              </button>
            </form>
            <p className="composer-hint">
              Press <kbd>Enter</kbd> to send <span>·</span>{" "}
              <button type="button" onClick={openExtractModal}>
                Extract brief <CircleHelp size={12} />
              </button>
            </p>
          </div>
        </section>

        <section
          className={`panel board-panel ${activeTab !== "Board" ? "mobile-hidden" : ""}`}
          aria-label="Project board"
        >
          <div className="panel-header board-header">
            <div>
              <h2>
                Board <span className="task-count">{tasks.length}</span>
              </h2>
            </div>
            <button
              className="icon-button small-icon"
              aria-label="Run AI check-in"
              onClick={() => {
                if (user && roomMeta) {
                  setCohortThinking(true)
                  void sendChatMessage(roomMeta.code, user, "@cohort check-in")
                    .then(() => runCohortCommand(roomMeta.code, user, { messageText: "@cohort check-in" }))
                    .catch((err) => {
                      const friendly = getFriendlyErrorMessage(err, "Check-in failed. Please try again.")
                      setError(friendly)
                      showToast(friendly, "error")
                    })
                    .finally(() => setCohortThinking(false))
                }
              }}
              title="Run @cohort check-in"
            >
              <Bot size={17} />
            </button>
          </div>
          <div className="project-summary">
            <div className="summary-icon">
              <Sparkles size={16} />
            </div>
            <div>
              <span>PROJECT SNAPSHOT</span>
              <p>{activeRoom.summary}</p>
            </div>
            <button
              aria-label="Extract board from brief"
              onClick={openExtractModal}
            >
              <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="board-toolbar">
            <div className="view-toggle" role="group" aria-label="Board display mode">
              <button
                onClick={() => setView("board")}
                className={view === "board" ? "active" : ""}
                aria-label="Kanban view"
              >
                <LayoutGrid size={15} />
              </button>
              <button
                onClick={() => setView("table")}
                className={view === "table" ? "active" : ""}
                aria-label="Table view"
              >
                <List size={16} />
              </button>
            </div>
            <button className="extract-button" onClick={openExtractModal}>
              <Plus size={14} /> Extract board
            </button>
          </div>

          {tasks.length ? (
            view === "board" ? (
              <div className="kanban-board">
                {statusColumns.map((column) => {
                  const colTasks = tasks.filter((task) => task.status === column.id)
                  return (
                    <div className="kanban-column" key={column.id}>
                      <div className="column-heading">
                        <span className={`status-dot ${column.dot}`} />
                        <span>{column.label}</span>
                        <span className="column-count">{colTasks.length}</span>
                      </div>
                      <div className="task-stack">
                        {colTasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            members={members}
                            menuOpen={taskMenuId === task.id}
                            updating={updatingTaskId === task.id}
                            onToggleMenu={() =>
                              setTaskMenuId(taskMenuId === task.id ? null : task.id)
                            }
                            onStatusChange={(status) => void changeTaskStatus(task, status)}
                            onReassign={(member) => void changeTaskOwner(task, member)}
                          />
                        ))}
                        {colTasks.length === 0 && (
                          <div className="column-empty">Nothing here yet</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Task</th>
                      <th>Owner</th>
                      <th>Status</th>
                      <th>Due</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <span className="task-id">{task.id}</span>
                        </td>
                        <td className="table-title">{task.title}</td>
                        <td>{task.suggested_owner}</td>
                        <td>
                          <StatusBadge status={task.status} />
                        </td>
                        <td>{task.due_date}</td>
                        <td>
                          <div className="table-quick-actions">
                            <button
                              type="button"
                              className={`quick-status-btn done ${task.status === "done" ? "is-active" : ""}`}
                              disabled={task.status === "done" || updatingTaskId === task.id}
                              onClick={() => void changeTaskStatus(task, "done")}
                            >
                              Mark done
                            </button>
                            <button
                              type="button"
                              className={`quick-status-btn blocked ${task.status === "blocked" ? "is-active" : ""}`}
                              disabled={task.status === "blocked" || updatingTaskId === task.id}
                              onClick={() => void changeTaskStatus(task, "blocked")}
                            >
                              Mark blocked
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="empty-board">
              <div>
                <LayoutGrid size={22} />
              </div>
              <strong>No board yet</strong>
              <p>
                Paste a project brief with <code>@cohort extract</code> in chat or click below to
                generate tasks with Gemini.
              </p>
              <button onClick={openExtractModal}>
                <Plus size={14} /> Extract from a brief
              </button>
            </div>
          )}

          <div className="board-footer">
            <span>
              <span className="live-dot" /> Changes sync automatically
            </span>
            <button onClick={() => showToast("Board synced in real time")}>
              Live Firestore sync <ArrowDown size={13} />
            </button>
          </div>
        </section>

        <aside
          className={`panel activity-panel ${activeTab !== "Log" ? "mobile-hidden" : ""}`}
          aria-label="Contribution log and members"
        >
          <div className="panel-header">
            <div>
              <h2>
                Activity <span className="activity-live">LIVE</span>
              </h2>
            </div>
            <button
              className="icon-button small-icon"
              aria-label="Copy invite code"
              onClick={copyCode}
            >
              <Share2 size={15} />
            </button>
          </div>
          <div className="activity-feed">
            {logs.map((entry) => {
              const isBotActor = entry.actorId === "cohort" || entry.actor === "cohort"
              const actorMember = members.find((m) => m.uid === entry.actorId)
              const avatarPalette = isBotActor
                ? "bot-avatar"
                : colors[colorIndexForId(entry.actorId || entry.actor)]
              return (
                <div key={entry.id} className="timeline-item">
                  <div className={`timeline-avatar ${avatarPalette}`}>
                    {isBotActor ? (
                      <Bot size={14} />
                    ) : actorMember?.photoURL ? (
                      <img
                        src={actorMember.photoURL}
                        alt={entry.actor}
                        className="avatar-img"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      initials(entry.actor)
                    )}
                  </div>
                  <div className="timeline-copy">
                    <p>
                      <strong>{entry.actor}</strong> {entry.action}{" "}
                      <span className="task-id">{entry.task_id}</span>
                    </p>
                    {entry.note && <p className="timeline-note">“{entry.note}”</p>}
                    <time>{relativeTime(entry.ts)}</time>
                  </div>
                </div>
              )
            })}
            {logs.length === 0 && (
              <p className="no-activity">Team activity and contribution logs will show up here.</p>
            )}
          </div>

          <div className="members-section">
            <div className="members-heading">
              <div>
                <h3>
                  Members <span>{members.length}</span>
                </h3>
              </div>
              <button
                onClick={copyCode}
                aria-label="Invite a teammate"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="member-list">
              {members.map((member) => {
                const onlineNow = isMemberOnline(member, nowMs)
                return (
                  <div className="member-row" key={member.uid}>
                    <span className={`member-avatar ${colors[colorIndexForId(member.uid)]}`}>
                      {member.photoURL ? (
                        <img
                          src={member.photoURL}
                          alt={member.name}
                          className="avatar-img"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        initials(member.name)
                      )}
                    </span>
                    <span className="member-name">
                      {member.name}
                      {member.uid === user?.uid && <small>you</small>}
                    </span>
                    <span className={`member-status ${onlineNow ? "online" : ""}`}>
                      {formatMemberLastSeen(member, nowMs)}
                    </span>
                  </div>
                )
              })}
            </div>
            <button className="invite-link" onClick={copyCode}>
              <Users size={15} /> Invite your teammates <ArrowRight size={14} />
            </button>
          </div>

          <div className="agent-card">
            <div className="agent-icon">
              <Bot size={17} />
            </div>
            <div>
              <strong>Your teammate, Cohort</strong>
              <p>Tag @cohort in chat to extract, mark, or check in.</p>
            </div>
            <span className="agent-spark">✳</span>
          </div>
        </aside>
      </div>

      {extractOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !extracting) setExtractOpen(false)
          }}
        >
          <section
            className="extract-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="extract-title"
          >
            <button
              className="dialog-close"
              onClick={() => setExtractOpen(false)}
              disabled={extracting}
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>
            <div className="dialog-icon">
              <Sparkles size={20} />
            </div>
            <p className="section-kicker">FROM BRIEF TO BOARD</p>
            <h2 id="extract-title">Let&apos;s make a game plan.</h2>
            <p className="dialog-description">
              Paste your assignment or project brief. Cohort will turn it into structured tasks with
              owners, due dates, and statuses.
            </p>
            <form onSubmit={submitExtract}>
              <label htmlFor="brief-input">Your project brief</label>
              <textarea
                id="brief-input"
                autoFocus
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="Paste your assignment, project goals, milestones, or a few notes to get started..."
                required
                disabled={extracting}
              />
              {tasks.length > 0 && (
                <div className="extract-mode-box">
                  <span className="extract-mode-title">
                    Board already has {tasks.length} task{tasks.length === 1 ? "" : "s"}
                  </span>
                  <div className="extract-mode-options" role="radiogroup" aria-label="Extraction mode">
                    <button
                      type="button"
                      className={`extract-mode-option ${extractMode === "merge" ? "active" : ""}`}
                      onClick={() => {
                        setExtractMode("merge")
                        setReplaceConfirmed(false)
                      }}
                      disabled={extracting}
                    >
                      <strong>Merge new tasks</strong>
                      <span>Keep existing tasks & progress, append new ones</span>
                    </button>
                    <button
                      type="button"
                      className={`extract-mode-option ${extractMode === "replace" ? "active" : ""}`}
                      onClick={() => setExtractMode("replace")}
                      disabled={extracting}
                    >
                      <strong>Replace board</strong>
                      <span>Clear current {tasks.length} tasks and start fresh</span>
                    </button>
                  </div>
                  {extractMode === "replace" && (
                    <label className="extract-confirm-check">
                      <input
                        type="checkbox"
                        checked={replaceConfirmed}
                        onChange={(event) => setReplaceConfirmed(event.target.checked)}
                        disabled={extracting}
                      />
                      <span>I understand this will delete the {tasks.length} existing tasks and their current progress.</span>
                    </label>
                  )}
                </div>
              )}
              {error && (
                <p className="form-error modal-error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-footer">
                <span>
                  <Sparkles size={13} /> Powered by server-side Gemini
                </span>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    !brief.trim() ||
                    extracting ||
                    (tasks.length > 0 && extractMode === "replace" && !replaceConfirmed)
                  }
                >
                  {extracting ? (
                    <>
                      <LoaderCircle className="spin" size={15} /> Extracting…
                    </>
                  ) : (
                    <>
                      {tasks.length > 0 && extractMode === "merge" ? "Add to board" : "Build my board"}{" "}
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {toast && (
        <div
          className={`toast-message ${toastTone === "error" ? "toast-error" : ""}`}
          role={toastTone === "error" ? "alert" : "status"}
        >
          <span className={`toast-check ${toastTone === "error" ? "is-error" : ""}`}>
            {toastTone === "error" ? <AlertCircle size={14} /> : <Check size={14} />}
          </span>
          {toast}
          <button onClick={() => setToast("")} aria-label="Dismiss notification">
            <X size={14} />
          </button>
        </div>
      )}
    </main>
  )
}

function MessageRow({ message, member }: { message: Message; member?: Member }) {
  const isBot = message.role === "assistant"
  const palette = isBot ? "bot-avatar" : colors[colorIndexForId(message.senderId || message.name)]
  return (
    <article className={`message-row ${isBot ? "bot-message" : ""}`}>
      <span className={`message-avatar ${palette}`}>
        {isBot ? (
          <Bot size={15} />
        ) : member?.photoURL ? (
          <img
            src={member.photoURL}
            alt={message.name}
            className="avatar-img"
            referrerPolicy="no-referrer"
          />
        ) : (
          initials(message.name)
        )}
      </span>
      <div className="message-content">
        <div className="message-meta">
          <strong>{isBot ? "@cohort" : message.name}</strong>
          {isBot && <span className="bot-label">TEAM BOT</span>}
          <time>{relativeTime(message.ts)}</time>
        </div>
        <div className="message-bubble">{message.text}</div>
      </div>
    </article>
  )
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const label =
    status === "in_progress"
      ? "In progress"
      : status === "todo"
        ? "To do"
        : status === "done"
          ? "Done"
          : "Blocked"
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {label}
    </span>
  )
}

function TaskCard({
  task,
  members,
  menuOpen,
  updating,
  onToggleMenu,
  onStatusChange,
  onReassign,
}: {
  task: Task
  members: Member[]
  menuOpen: boolean
  updating: boolean
  onToggleMenu: () => void
  onStatusChange: (status: TaskStatus) => void
  onReassign: (member: Member) => void
}) {
  return (
    <article className="task-card">
      <div className="task-card-top">
        <span className="task-id">{task.id}</span>
        <button
          aria-label={`Options for ${task.title}`}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          onClick={onToggleMenu}
          disabled={updating}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
      <h3>{task.title}</h3>
      <div className="task-card-bottom">
        <span className="task-owner">
          <span className="owner-avatar">
            {initials(task.suggested_owner.replace(/^@/, ""))}
          </span>
          {task.suggested_owner}
        </span>
        <span className="due-date">
          <ArrowUpRight size={12} />
          {task.due_date}
        </span>
      </div>
      <div className="task-quick-actions" role="group" aria-label={`Quick status actions for ${task.title}`}>
        <button
          type="button"
          className={`quick-status-btn done ${task.status === "done" ? "is-active" : ""}`}
          disabled={task.status === "done" || updating}
          onClick={() => onStatusChange("done")}
        >
          <Check size={11} />
          Mark done
        </button>
        <button
          type="button"
          className={`quick-status-btn blocked ${task.status === "blocked" ? "is-active" : ""}`}
          disabled={task.status === "blocked" || updating}
          onClick={() => onStatusChange("blocked")}
        >
          <AlertCircle size={11} />
          Mark blocked
        </button>
      </div>
      {menuOpen && (
        <div
          className="task-actions"
          role="group"
          aria-label={`Actions for ${task.title}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") onToggleMenu()
          }}
        >
          <button onClick={() => onStatusChange("todo")} disabled={task.status === "todo" || updating}>
            To do
          </button>
          <button
            onClick={() => onStatusChange("in_progress")}
            disabled={task.status === "in_progress" || updating}
          >
            In progress
          </button>
          <button onClick={() => onStatusChange("done")} disabled={task.status === "done" || updating}>
            <Check size={13} />
            Mark done
          </button>
          <button
            onClick={() => onStatusChange("blocked")}
            disabled={task.status === "blocked" || updating}
          >
            <X size={13} />
            Mark blocked
          </button>
          {members.length > 0 && (
            <>
              <div className="task-action-divider" />
              <span>Reassign to</span>
              {members.map((member) => (
                <button
                  key={member.uid}
                  onClick={() => onReassign(member)}
                  disabled={task.owner_uid === member.uid || updating}
                >
                  <span className="owner-avatar">{initials(member.name)}</span>
                  {member.name}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </article>
  )
}

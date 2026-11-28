"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth"
import { auth, googleProvider, validateFirestoreConnection } from "@/lib/firebase"
import {
  approvePendingMember,
  createRoomOnServer,
  deleteTaskFirestore,
  ensureRoomMembership,
  getBlockedUntilIso,
  getFriendlyErrorMessage,
  getRecentRoomsStorageKey,
  getUserDisplayName,
  InviteExpiredOrLimitError,
  leaveRoomMembership,
  loadOlderMessages,
  mergeFairnessLogs,
  mergeLiveMessages,
  mergeOlderMessages,
  normalizeRoomCode,
  reassignTaskFirestore,
  RECENT_ROOMS_LIMIT,
  RejectedCooldownError,
  rejectPendingMember,
  ROOM_CODE_REGEX,
  RoomNotFoundError,
  runCohortCommand,
  sendChatMessage,
  setMemberPresence,
  shouldFallbackToRedirectSignIn,
  subscribeToPendingRoom,
  subscribeToRoom,
  subscribeToRoomInvites,
  suggestDefaultRoomTitle,
  triggerCohortPulse,
  updateRoomAgentAggressiveness,
  updateTaskStatusFirestore,
  upsertRecentRoom,
  validateInviteLink,
  type AgentAggressiveness,
  type Invite,
  type LogEntry,
  type Member,
  type MemberRole,
  type Message,
  type MessageCursor,
  type RecentRoomEntry,
  type RoomFile,
  type RoomMeta,
  type Task,
  type TaskStatus,
} from "@/lib/api"
import { PROACTIVE_THRESHOLDS } from "@/lib/proactive-cohort"
import ActivityMembersPanel from "@/components/room/activity-members-panel"
import BoardPanel from "@/components/room/board-panel"
import ChatPanel from "@/components/room/chat-panel"
import FilesPanel from "@/components/room/files-panel"
import JoinRoomScreen from "@/components/room/join-room-screen"
import RoomShell from "@/components/room/room-shell"
import {
  PendingApprovalView,
  RejectedCooldownView,
  RoomNotFoundView,
  SessionLoadingView,
} from "@/components/room/room-state-views"
import { themeStorageKey } from "@/components/room/ui-helpers"

export default function CohortApp({
  mode,
  code = "",
  inviteId = "",
}: {
  mode: "join" | "room"
  code?: string
  inviteId?: string
}) {
  const router = useRouter()
  const normalizedRouteCode = normalizeRoomCode(code)

  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [signingIn, setSigningIn] = useState(false)

  const [roomMeta, setRoomMeta] = useState<RoomMeta | null>(null)
  const [memberRole, setMemberRole] = useState<MemberRole | null>(null)
  const [requestRejected, setRequestRejected] = useState(false)
  const [rejectedUntilIso, setRejectedUntilIso] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [files, setFiles] = useState<RoomFile[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [fairnessLogs, setFairnessLogs] = useState<LogEntry[]>([])
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [invites, setInvites] = useState<Invite[]>([])

  const [activeInviteId, setActiveInviteId] = useState(() => inviteId.trim())
  const [inviteCheckStatus, setInviteCheckStatus] = useState<"idle" | "checking" | "valid" | "invalid">("idle")
  const [inviteRemainingUses, setInviteRemainingUses] = useState<number | null>(null)
  const [roomCode, setRoomCode] = useState(() =>
    mode === "join" && ROOM_CODE_REGEX.test(normalizedRouteCode) ? normalizedRouteCode : ""
  )
  const [projectTitle, setProjectTitle] = useState("")
  const [isJoined, setIsJoined] = useState(false)
  const [roomLoading, setRoomLoading] = useState(mode === "room")
  const [roomNotFound, setRoomNotFound] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [roomMenuOpen, setRoomMenuOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [cohortThinking, setCohortThinking] = useState(false)
  const [activeTab, setActiveTab] = useState("Chat")
  const [centerPanel, setCenterPanel] = useState<"board" | "files">("board")
  const [view, setView] = useState<"board" | "table" | "fairness">("board")
  const [extractOpen, setExtractOpen] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [toast, setToast] = useState("")
  const [toastTone, setToastTone] = useState<"success" | "error">("success")
  const [joining, setJoining] = useState(false)
  const [dark, setDark] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null)
  const [approvingUid, setApprovingUid] = useState<string | null>(null)
  const [savingAggressiveness, setSavingAggressiveness] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [recentRooms, setRecentRooms] = useState<RecentRoomEntry[]>([])

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const olderMessageCursorRef = useRef<MessageCursor | null>(null)
  const hasLoadedOlderRef = useRef(false)
  const skipAutoScrollRef = useRef(false)
  const leftRoomRef = useRef(false)
  const rejectedRef = useRef(false)

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
    let cancelled = false
    getRedirectResult(auth).catch((cause) => {
      if (cancelled) return
      const errCode = (cause as { code?: string })?.code || ""
      if (
        errCode &&
        errCode !== "auth/popup-closed-by-user" &&
        errCode !== "auth/cancelled-popup-request"
      ) {
        setError("Google sign-in didn’t complete. Please try again.")
      }
    })
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setAuthLoading(false)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  useEffect(() => {
    if (mode !== "join") return
    const cleanInvite = inviteId.trim()
    setActiveInviteId(cleanInvite)
    if (ROOM_CODE_REGEX.test(normalizedRouteCode)) {
      setRoomCode(normalizedRouteCode)
    } else if (cleanInvite && normalizedRouteCode) {
      setRoomCode(normalizedRouteCode)
    }
  }, [mode, normalizedRouteCode, inviteId])

  useEffect(() => {
    if (mode !== "join") return
    if (!activeInviteId) {
      setInviteCheckStatus("idle")
      setInviteRemainingUses(null)
      return
    }
    if (!ROOM_CODE_REGEX.test(roomCode)) {
      setInviteCheckStatus("invalid")
      setInviteRemainingUses(null)
      setError("This invite link has expired or reached its limit")
      return
    }
    if (!user || user.emailVerified === false) {
      setInviteCheckStatus("idle")
      return
    }

    let cancelled = false
    setInviteCheckStatus("checking")
    setError("")
    validateInviteLink(roomCode, activeInviteId)
      .then((res) => {
        if (cancelled) return
        if (res.valid) {
          setInviteCheckStatus("valid")
          setInviteRemainingUses(res.remainingUses ?? null)
        } else {
          setInviteCheckStatus("invalid")
          setInviteRemainingUses(0)
          setError("This invite link has expired or reached its limit")
        }
      })
      .catch(() => {
        if (cancelled) return
        setInviteCheckStatus("invalid")
        setError("This invite link has expired or reached its limit")
      })

    return () => {
      cancelled = true
    }
  }, [mode, user, activeInviteId, roomCode])

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

    if (!user || user.emailVerified === false) {
      setIsJoined(false)
      setMemberRole(null)
      setRoomLoading(false)
      return
    }

    let active = true
    leftRoomRef.current = false
    rejectedRef.current = false
    olderMessageCursorRef.current = null
    hasLoadedOlderRef.current = false
    skipAutoScrollRef.current = false
    setMessages([])
    setFiles([])
    setLogs([])
    setFairnessLogs([])
    setCenterPanel("board")
    setHasMoreMessages(false)
    setRoomLoading(true)
    setRoomNotFound(false)
    setRequestRejected(false)
    setRejectedUntilIso(null)
    setMemberRole(null)
    setError("")

    ensureRoomMembership(normalizedRouteCode, user)
      .then(({ meta, memberRole: nextRole }) => {
        if (!active) return
        setRoomMeta(meta)
        setMemberRole(nextRole)
        setIsJoined(true)
        setRoomLoading(false)
      })
      .catch((cause) => {
        if (!active) return
        if (cause instanceof RoomNotFoundError) {
          setRoomNotFound(true)
        } else if (cause instanceof RejectedCooldownError) {
          rejectedRef.current = true
          setRejectedUntilIso(cause.untilIso)
          setRequestRejected(true)
        } else {
          setError(getFriendlyErrorMessage(cause, "We couldn’t open that room. Please try again."))
        }
        setRoomLoading(false)
      })

    const heartbeatId = window.setInterval(() => {
      setNowMs(Date.now())
      if (document.visibilityState === "visible" && !leftRoomRef.current && !rejectedRef.current) {
        void setMemberPresence(normalizedRouteCode, user, true).catch(() => {})
      }
    }, 45_000)

    const handleVisibilityChange = () => {
      setNowMs(Date.now())
      if (leftRoomRef.current || rejectedRef.current) return
      const visible = document.visibilityState === "visible"
      void setMemberPresence(normalizedRouteCode, user, visible).catch(() => {})
    }

    const handleBeforeUnload = () => {
      if (!leftRoomRef.current && !rejectedRef.current) {
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
      if (!leftRoomRef.current && !rejectedRef.current) {
        void setMemberPresence(normalizedRouteCode, user, false).catch(() => {})
      }
    }
  }, [mode, normalizedRouteCode, authLoading, user])

  useEffect(() => {
    if (mode !== "room" || !user || user.emailVerified === false || !isJoined || !memberRole) {
      return
    }

    let active = true

    if (memberRole === "pending") {
      const unsubPending = subscribeToPendingRoom(normalizedRouteCode, user.uid, {
        onRoom: (nextMeta) => {
          if (!active) return
          setRoomMeta(nextMeta)
          setReconnecting(false)
        },
        onMemberRole: (nextRole) => {
          if (!active) return
          if (nextRole === "owner" || nextRole === "member") {
            setMemberRole(nextRole)
            showToast("Your join request was approved!")
          }
        },
        onRejected: () => {
          if (!active) return
          rejectedRef.current = true
          setRequestRejected(true)
          setIsJoined(false)
          setMemberRole(null)
          void getBlockedUntilIso(normalizedRouteCode, user.uid)
            .then((untilIso) => {
              if (active && untilIso) setRejectedUntilIso(untilIso)
            })
            .catch(() => {})
        },
        onNotFound: () => {
          if (!active) return
          setRoomNotFound(true)
          setIsJoined(false)
          setMemberRole(null)
        },
        onError: () => {
          if (!active) return
          setReconnecting(true)
        },
      })

      return () => {
        active = false
        unsubPending()
      }
    }

    const unsubRoom = subscribeToRoom(normalizedRouteCode, {
      onRoom: (nextMeta) => {
        if (!active) return
        setRoomMeta(nextMeta)
        setReconnecting(false)
      },
      onMembers: (nextMembers) => {
        if (!active) return
        setMembers(nextMembers)
        const self = nextMembers.find((m) => m.uid === user.uid)
        if (self && self.role !== memberRole) {
          setMemberRole(self.role)
        }
      },
      onMessages: (nextMessages) => {
        if (!active) return
        setMessages((prev) => mergeLiveMessages(prev, nextMessages))
      },
      onMessagesMeta: (meta) => {
        if (!active) return
        if (!hasLoadedOlderRef.current) {
          olderMessageCursorRef.current = meta.cursor
          setHasMoreMessages(meta.hasMore)
        }
      },
      onTasks: (nextTasks) => {
        if (!active) return
        setTasks(nextTasks)
      },
      onFiles: (nextFiles) => {
        if (!active) return
        setFiles(nextFiles)
      },
      onLogs: (nextLogs) => {
        if (!active) return
        setLogs(nextLogs)
      },
      onFairnessLogs: (nextFairnessLogs) => {
        if (!active) return
        setFairnessLogs(nextFairnessLogs)
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

    const unsubInvites =
      memberRole === "owner"
        ? subscribeToRoomInvites(
            normalizedRouteCode,
            (nextInvites) => {
              if (!active) return
              setInvites(nextInvites)
            },
            () => {}
          )
        : null

    return () => {
      active = false
      unsubRoom()
      if (unsubInvites) unsubInvites()
    }
  }, [mode, normalizedRouteCode, user, isJoined, memberRole])

  useEffect(() => {
    if (
      mode !== "room" ||
      !user ||
      user.emailVerified === false ||
      !isJoined ||
      (memberRole !== "owner" && memberRole !== "member")
    ) {
      return
    }

    let cancelled = false
    const runPulse = () => {
      if (cancelled || document.visibilityState !== "visible") return
      void triggerCohortPulse(normalizedRouteCode, user).catch(() => {})
    }

    const initialTimer = window.setTimeout(runPulse, 10_000)
    const intervalId = window.setInterval(runPulse, 180_000)

    return () => {
      cancelled = true
      window.clearTimeout(initialTimer)
      window.clearInterval(intervalId)
    }
  }, [mode, normalizedRouteCode, user, isJoined, memberRole])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(""), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!user) {
      setRecentRooms([])
      return
    }
    const storageKey = getRecentRoomsStorageKey(user.uid)
    try {
      const raw = localStorage.getItem(storageKey)
      const parsed = raw ? (JSON.parse(raw) as RecentRoomEntry[]) : []
      const valid = Array.isArray(parsed)
        ? parsed
            .filter(
              (r): r is RecentRoomEntry =>
                Boolean(r && typeof r.code === "string" && typeof r.title === "string")
            )
            .slice(0, RECENT_ROOMS_LIMIT)
        : []
      if (!roomMeta) {
        setRecentRooms(valid)
        return
      }
      const updated = upsertRecentRoom(valid, { code: roomMeta.code, title: roomMeta.title })
      localStorage.setItem(storageKey, JSON.stringify(updated))
      setRecentRooms(updated)
    } catch {
      setRecentRooms(roomMeta ? [{ code: roomMeta.code, title: roomMeta.title }] : [])
    }
  }, [user, roomMeta])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false
      return
    }
    el.scrollTop = el.scrollHeight
  }, [messages.length, cohortThinking])

  const mergedFairnessLogs = useMemo(
    () => mergeFairnessLogs(logs, fairnessLogs),
    [logs, fairnessLogs]
  )

  const handleLoadOlderMessages = async () => {
    if (!roomMeta || loadingOlderMessages || !olderMessageCursorRef.current) return
    setLoadingOlderMessages(true)
    try {
      const page = await loadOlderMessages(roomMeta.code, olderMessageCursorRef.current)
      skipAutoScrollRef.current = true
      hasLoadedOlderRef.current = true
      olderMessageCursorRef.current = page.nextCursor
      setHasMoreMessages(page.hasMore)
      setMessages((prev) => mergeOlderMessages(prev, page.messages))
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not load older messages.")
      showToast(friendly, "error")
    } finally {
      setLoadingOlderMessages(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setSigningIn(true)
    setError("")
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (cause) {
      const errCode = (cause as { code?: string })?.code || ""
      if (errCode === "auth/popup-closed-by-user" || errCode === "auth/cancelled-popup-request") {
        // User dismissed popup; do not fall back or show an alarming error.
      } else if (shouldFallbackToRedirectSignIn(cause)) {
        try {
          await signInWithRedirect(auth, googleProvider)
          return
        } catch {
          setError("Google sign-in didn’t complete. Please try again.")
        }
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
        const { memberRole: nextRole } = await ensureRoomMembership(
          trimmedCode,
          user,
          activeInviteId || undefined
        )
        showToast(
          nextRole === "pending"
            ? "Join request sent — waiting for owner approval"
            : "Welcome to your room"
        )
        router.push(`/room/${trimmedCode}`)
      } else {
        const finalTitle = trimmedTitle || suggestDefaultRoomTitle(user)
        const createdCode = await createRoomOnServer(user, finalTitle)
        showToast("Your room is ready")
        router.push(`/room/${createdCode}`)
      }
    } catch (cause) {
      const friendly =
        cause instanceof InviteExpiredOrLimitError
          ? "This invite link has expired or reached its limit"
          : cause instanceof RoomNotFoundError
            ? "Room not found. Check the code and try again, or create a new room."
            : getFriendlyErrorMessage(cause, "We couldn’t open that room. Please try again.")
      if (cause instanceof InviteExpiredOrLimitError) {
        setInviteCheckStatus("invalid")
      }
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

  const runAiCheckIn = () => {
    if (!user || !roomMeta) return
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

  const openExtractModal = () => {
    setError("")
    setExtractOpen(true)
  }

  const submitExtract = async ({
    brief,
    extractMode,
    replaceConfirmed,
  }: {
    brief: string
    extractMode: "merge" | "replace"
    replaceConfirmed: boolean
  }): Promise<boolean> => {
    if (!roomMeta || !user || !brief.trim() || extracting) return false
    if (tasks.length > 0 && extractMode === "replace" && !replaceConfirmed) {
      setError("Please confirm replacing existing tasks or switch to Merge mode.")
      return false
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
      setExtractOpen(false)
      showToast(
        hadTasks && extractMode === "merge"
          ? "New tasks merged into your board"
          : "Board extracted from your brief"
      )
      return true
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not extract tasks from your brief.")
      setError(friendly)
      showToast(friendly, "error")
      return false
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
      showToast(`Task reassigned to ${member.name}`)
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "We couldn’t reassign that task. Please try again.")
      setError(friendly)
      showToast(friendly, "error")
    } finally {
      setUpdatingTaskId(null)
    }
  }

  const handleDeleteTask = async (task: Task) => {
    if (!roomMeta || !user || updatingTaskId) return
    setUpdatingTaskId(task.id)
    setError("")
    try {
      await deleteTaskFirestore(roomMeta.code, task, user)
      showToast("Task deleted")
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "We couldn’t delete that task. Please try again.")
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
    if (roomMeta?.ownerId === user?.uid || memberRole === "owner") {
      showToast("Transfer ownership is not available yet", "error")
      return
    }
    leftRoomRef.current = true
    if (roomMeta && user) {
      await leaveRoomMembership(roomMeta.code, user).catch(() => {})
    }
    router.push("/join")
  }

  const handleApproveMember = async (member: Member) => {
    if (!roomMeta || approvingUid) return
    setApprovingUid(member.uid)
    setError("")
    try {
      await approvePendingMember(roomMeta.code, member.uid)
      showToast(`Approved ${member.name}`)
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not approve join request.")
      setError(friendly)
      showToast(friendly, "error")
    } finally {
      setApprovingUid(null)
    }
  }

  const handleRejectMember = async (member: Member) => {
    if (!roomMeta || approvingUid) return
    setApprovingUid(member.uid)
    setError("")
    try {
      await rejectPendingMember(roomMeta.code, member.uid)
      showToast(`Declined ${member.name}`)
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not decline join request.")
      setError(friendly)
      showToast(friendly, "error")
    } finally {
      setApprovingUid(null)
    }
  }

  const handleAggressivenessChange = async (level: AgentAggressiveness) => {
    if (!roomMeta || savingAggressiveness || roomMeta.agentAggressiveness === level) return
    setSavingAggressiveness(true)
    try {
      await updateRoomAgentAggressiveness(roomMeta.code, level)
      showToast(`@cohort proactivity set to ${PROACTIVE_THRESHOLDS[level].label}`)
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not update @cohort proactivity.")
      showToast(friendly, "error")
    } finally {
      setSavingAggressiveness(false)
    }
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
    return <RoomNotFoundView />
  }

  if (authLoading || (mode === "room" && user && user.emailVerified !== false && roomLoading)) {
    return <SessionLoadingView authLoading={authLoading} />
  }

  if (mode === "room" && user && requestRejected) {
    return (
      <RejectedCooldownView
        roomCode={roomMeta?.code || normalizedRouteCode}
        rejectedUntilIso={rejectedUntilIso}
      />
    )
  }

  if (mode === "room" && user && roomMeta && memberRole === "pending") {
    return (
      <PendingApprovalView
        roomMeta={roomMeta}
        onCancelRequest={() => void handleLeaveRoom()}
        onSignOut={() => void handleSignOut()}
      />
    )
  }

  const roomReady = Boolean(
    mode === "room" &&
      user &&
      roomMeta &&
      isJoined &&
      (memberRole === "owner" || memberRole === "member")
  )
  const currentUserName = user ? getUserDisplayName(user) : ""

  if (!roomReady) {
    return (
      <JoinRoomScreen
        mode={mode}
        normalizedRouteCode={normalizedRouteCode}
        roomCode={roomCode}
        projectTitle={projectTitle}
        user={user}
        currentUserName={currentUserName}
        signingIn={signingIn}
        joining={joining}
        dark={dark}
        error={error}
        activeInviteId={activeInviteId}
        inviteCheckStatus={inviteCheckStatus}
        inviteRemainingUses={inviteRemainingUses}
        onToggleTheme={toggleTheme}
        onGoogleSignIn={() => void handleGoogleSignIn()}
        onSignOut={() => void handleSignOut()}
        onEnterRoom={(e) => void enterRoom(e)}
        onRoomCodeChange={(rawVal) => {
          const nextVal = rawVal
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 8)
          setRoomCode(nextVal)
          if (activeInviteId && nextVal !== normalizedRouteCode) {
            setActiveInviteId("")
            setInviteCheckStatus("idle")
            setError("")
          }
        }}
        onProjectTitleChange={setProjectTitle}
        onClearInvite={() => {
          setActiveInviteId("")
          setInviteCheckStatus("idle")
          setError("")
          setRoomCode("")
        }}
      />
    )
  }

  const activeRoom = roomMeta as RoomMeta
  const isOwner = memberRole === "owner" || activeRoom.ownerId === user?.uid
  const approvedMembers = members.filter((m) => m.role !== "pending")
  const pendingMembers = members.filter((m) => m.role === "pending")
  const remoteThinkingMs = activeRoom.agentStatusAt ? Date.parse(activeRoom.agentStatusAt) : 0
  const remoteAgentThinking =
    activeRoom.agentStatus === "thinking" &&
    !Number.isNaN(remoteThinkingMs) &&
    nowMs - remoteThinkingMs < 30_000
  const agentThinkingNow = cohortThinking || remoteAgentThinking

  const handleSetActiveTab = (tab: string) => {
    setActiveTab(tab)
    if (tab === "Files") {
      setCenterPanel("files")
    } else if (tab === "Board") {
      setCenterPanel("board")
    }
  }

  return (
    <RoomShell
      activeRoom={activeRoom}
      user={user}
      currentUserName={currentUserName}
      isOwner={isOwner}
      approvedMembers={approvedMembers}
      recentRooms={recentRooms}
      nowMs={nowMs}
      dark={dark}
      copied={copied}
      reconnecting={reconnecting}
      hasTasks={tasks.length > 0}
      agentThinkingNow={agentThinkingNow}
      activeTab={activeTab}
      roomMenuOpen={roomMenuOpen}
      toast={toast}
      toastTone={toastTone}
      onSetRoomMenuOpen={setRoomMenuOpen}
      onSetActiveTab={handleSetActiveTab}
      onCopyCode={() => void copyCode()}
      onCopyInviteLink={() => void copyInviteLink()}
      onToggleTheme={toggleTheme}
      onLeaveRoom={() => void handleLeaveRoom()}
      onSignOut={() => void handleSignOut()}
      onDismissToast={() => setToast("")}
    >
      <ChatPanel
        activeTab={activeTab}
        messagesContainerRef={messagesContainerRef}
        hasMoreMessages={hasMoreMessages}
        loadingOlderMessages={loadingOlderMessages}
        messages={messages}
        members={members}
        cohortThinking={cohortThinking}
        error={error}
        message={message}
        taskCount={tasks.length}
        extractOpen={extractOpen}
        extracting={extracting}
        onLoadOlderMessages={() => void handleLoadOlderMessages()}
        onDismissError={() => setError("")}
        onMessageChange={setMessage}
        onSendMessage={(e) => void send(e)}
        onFillCommand={fillCommand}
        onOpenExtractModal={openExtractModal}
        onCloseExtractModal={() => setExtractOpen(false)}
        onSubmitExtract={submitExtract}
      />

      {centerPanel === "files" ? (
        <FilesPanel
          activeRoom={activeRoom}
          user={user}
          isOwner={isOwner}
          activeTab={activeTab}
          files={files}
          members={members}
          onSwitchToBoard={() => handleSetActiveTab("Board")}
          onToast={showToast}
        />
      ) : (
        <BoardPanel
          activeRoom={activeRoom}
          user={user}
          activeTab={activeTab}
          view={view}
          tasks={tasks}
          fileCount={files.length}
          approvedMembers={approvedMembers}
          mergedFairnessLogs={mergedFairnessLogs}
          nowMs={nowMs}
          updatingTaskId={updatingTaskId}
          onSetView={setView}
          onSwitchToFiles={() => handleSetActiveTab("Files")}
          onRunCheckIn={runAiCheckIn}
          onOpenExtractModal={openExtractModal}
          onChangeTaskStatus={(task, status) => void changeTaskStatus(task, status)}
          onChangeTaskOwner={(task, member) => void changeTaskOwner(task, member)}
          onDeleteTask={(task) => void handleDeleteTask(task)}
          onToast={showToast}
        />
      )}

      <ActivityMembersPanel
        activeRoom={activeRoom}
        user={user}
        isOwner={isOwner}
        activeTab={activeTab}
        logs={logs}
        members={members}
        approvedMembers={approvedMembers}
        pendingMembers={pendingMembers}
        invites={invites}
        nowMs={nowMs}
        agentThinkingNow={agentThinkingNow}
        approvingUid={approvingUid}
        savingAggressiveness={savingAggressiveness}
        onCopyCode={() => void copyCode()}
        onApproveMember={(member) => void handleApproveMember(member)}
        onRejectMember={(member) => void handleRejectMember(member)}
        onAggressivenessChange={(level) => void handleAggressivenessChange(level)}
        onError={setError}
        onToast={showToast}
      />
    </RoomShell>
  )
}

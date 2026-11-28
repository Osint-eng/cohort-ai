"use client"

import { useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import type { User } from "firebase/auth"
import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  Clipboard,
  Command,
  Hash,
  LayoutGrid,
  LogOut,
  MessageCircle,
  Moon,
  Plus,
  Share2,
  Sun,
  Users,
  X,
} from "lucide-react"
import { isMemberOnline, type Member, type RecentRoomEntry, type RoomMeta } from "@/lib/api"
import { PROACTIVE_THRESHOLDS } from "@/lib/proactive-cohort"
import { colorIndexForId, colors, initials } from "./ui-helpers"
import "@/app/styles/room-shell.css"

export default function RoomShell({
  activeRoom,
  user,
  currentUserName,
  isOwner,
  approvedMembers,
  recentRooms,
  nowMs,
  dark,
  copied,
  reconnecting,
  hasTasks,
  agentThinkingNow,
  activeTab,
  roomMenuOpen,
  toast,
  toastTone,
  onSetRoomMenuOpen,
  onSetActiveTab,
  onCopyCode,
  onCopyInviteLink,
  onToggleTheme,
  onLeaveRoom,
  onSignOut,
  onDismissToast,
  children,
}: {
  activeRoom: RoomMeta
  user: User | null
  currentUserName: string
  isOwner: boolean
  approvedMembers: Member[]
  recentRooms: RecentRoomEntry[]
  nowMs: number
  dark: boolean
  copied: boolean
  reconnecting: boolean
  hasTasks: boolean
  agentThinkingNow: boolean
  activeTab: string
  roomMenuOpen: boolean
  toast: string
  toastTone: "success" | "error"
  onSetRoomMenuOpen: (open: boolean) => void
  onSetActiveTab: (tab: string) => void
  onCopyCode: () => void
  onCopyInviteLink: () => void
  onToggleTheme: () => void
  onLeaveRoom: () => void
  onSignOut: () => void
  onDismissToast: () => void
  children: ReactNode
}) {
  const router = useRouter()
  const [myRoomsOpen, setMyRoomsOpen] = useState(false)
  const [shareCardDismissed, setShareCardDismissed] = useState(false)

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
        <div className="room-switcher-wrap">
          <button
            type="button"
            className="room-heading room-heading-btn"
            onClick={() => setMyRoomsOpen(!myRoomsOpen)}
            aria-haspopup="menu"
            aria-expanded={myRoomsOpen}
            aria-label="Switch project room"
          >
            <span className="room-icon">
              <Command size={16} />
            </span>
            <div>
              <strong>{activeRoom.title}</strong>
              <span>My rooms</span>
            </div>
            <ChevronDown size={15} className="muted-icon" />
          </button>
          {myRoomsOpen && (
            <div className="my-rooms-menu" role="menu" aria-label="My rooms">
              <span className="my-rooms-label">Recent rooms</span>
              {recentRooms.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  role="menuitem"
                  className={`my-rooms-item ${r.code === activeRoom.code ? "active" : ""}`}
                  onClick={() => {
                    setMyRoomsOpen(false)
                    if (r.code !== activeRoom.code) {
                      router.push(`/room/${r.code}`)
                    }
                  }}
                >
                  <span className="my-rooms-item-title">{r.title}</span>
                  <span className="my-rooms-item-code">{r.code}</span>
                </button>
              ))}
              <div className="my-rooms-divider" />
              <a
                href="/join"
                className="my-rooms-action"
                role="menuitem"
                onClick={() => setMyRoomsOpen(false)}
              >
                <Plus size={14} /> Create or join another room
              </a>
            </div>
          )}
        </div>
        <div className="topbar-spacer" />
        <button
          className="room-code"
          onClick={onCopyCode}
          aria-label={`Copy room code ${activeRoom.code}`}
        >
          <Hash size={14} /> {activeRoom.code} {copied ? <Check size={14} /> : <Clipboard size={13} />}
        </button>
        <button className="invite-link-button" onClick={onCopyInviteLink} aria-label="Copy invite link">
          <Share2 size={14} />
          <span>Copy invite link</span>
        </button>
        <div
          className={`agent-presence-pill ${agentThinkingNow ? "is-thinking" : ""}`}
          title={PROACTIVE_THRESHOLDS[activeRoom.agentAggressiveness].description}
        >
          <span className="agent-presence-dot" />
          <Bot size={13} />
          <span>@cohort · {agentThinkingNow ? "thinking…" : "watching"}</span>
        </div>
        <div className="online-members">
          <span className="online-dot" />
          <span>{approvedMembers.filter((member) => isMemberOnline(member, nowMs)).length} online</span>
          <div className="mini-avatars">
            {approvedMembers.slice(0, 3).map((member) => (
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
          onClick={onToggleTheme}
        >
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <div className="room-menu-wrap">
          <button
            className="user-menu"
            aria-label={`Room options for ${currentUserName}`}
            aria-haspopup="menu"
            aria-expanded={roomMenuOpen}
            onClick={() => onSetRoomMenuOpen(!roomMenuOpen)}
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
              {isOwner ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled
                  title="Transfer ownership is not available yet"
                  className="opacity-60 cursor-not-allowed flex-col items-start gap-0.5"
                >
                  <span className="flex items-center gap-2">
                    <LogOut size={14} /> Leave room
                  </span>
                  <span className="text-[10px] text-[var(--muted-foreground)]">
                    Transfer ownership is not available yet
                  </span>
                </button>
              ) : (
                <button type="button" role="menuitem" onClick={onLeaveRoom}>
                  <LogOut size={14} /> Leave room
                </button>
              )}
              <button role="menuitem" onClick={onSignOut}>
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

      {!shareCardDismissed && !hasTasks && (
        <section className="share-room-card" aria-label="Share this room">
          <div className="share-room-copy">
            <span className="share-room-icon">
              <Users size={17} />
            </span>
            <div>
              <strong>Share this room with your team</strong>
              <p>
                Send the room code or invite link so teammates can join and collaborate in real time.
              </p>
            </div>
          </div>
          <div className="share-room-actions">
            <button
              type="button"
              className="share-code-pill"
              onClick={onCopyCode}
              aria-label={`Copy room code ${activeRoom.code}`}
            >
              <Hash size={13} />
              {activeRoom.code}
              {copied ? <Check size={13} /> : <Clipboard size={12} />}
            </button>
            <button type="button" className="share-link-cta" onClick={onCopyInviteLink}>
              <Share2 size={13} />
              Copy invite link
            </button>
            <button
              type="button"
              className="share-dismiss-btn"
              onClick={() => setShareCardDismissed(true)}
              aria-label="Dismiss share card"
            >
              <X size={14} />
            </button>
          </div>
        </section>
      )}

      <nav className="mobile-tabs" aria-label="Workspace sections">
        {["Chat", "Board", "Log"].map((tab) => (
          <button
            key={tab}
            onClick={() => onSetActiveTab(tab)}
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

      <div className="workspace-grid">{children}</div>

      {toast && (
        <div
          className={`toast-message ${toastTone === "error" ? "toast-error" : ""}`}
          role={toastTone === "error" ? "alert" : "status"}
        >
          <span className={`toast-check ${toastTone === "error" ? "is-error" : ""}`}>
            {toastTone === "error" ? <AlertCircle size={14} /> : <Check size={14} />}
          </span>
          {toast}
          <button onClick={onDismissToast} aria-label="Dismiss notification">
            <X size={14} />
          </button>
        </div>
      )}
    </main>
  )
}

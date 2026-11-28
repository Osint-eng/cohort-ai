"use client"

import { useState, type FormEvent } from "react"
import type { User } from "firebase/auth"
import {
  ArrowRight,
  Ban,
  Bot,
  ChevronDown,
  Clipboard,
  Link2,
  LoaderCircle,
  Plus,
  Share2,
  ShieldCheck,
  UserCheck,
  Users,
  UserX,
} from "lucide-react"
import {
  createTemporaryInvite,
  formatMemberLastSeen,
  getFriendlyErrorMessage,
  isMemberOnline,
  revokeInvite,
  type AgentAggressiveness,
  type Invite,
  type LogEntry,
  type Member,
  type RoomMeta,
} from "@/lib/api"
import { PROACTIVE_THRESHOLDS } from "@/lib/proactive-cohort"
import { colorIndexForId, colors, initials, relativeTime } from "./ui-helpers"
import "@/app/styles/members.css"

export default function ActivityMembersPanel({
  activeRoom,
  user,
  isOwner,
  activeTab,
  logs,
  members,
  approvedMembers,
  pendingMembers,
  invites,
  nowMs,
  agentThinkingNow,
  approvingUid,
  savingAggressiveness,
  onCopyCode,
  onApproveMember,
  onRejectMember,
  onAggressivenessChange,
  onError,
  onToast,
}: {
  activeRoom: RoomMeta
  user: User | null
  isOwner: boolean
  activeTab: string
  logs: LogEntry[]
  members: Member[]
  approvedMembers: Member[]
  pendingMembers: Member[]
  invites: Invite[]
  nowMs: number
  agentThinkingNow: boolean
  approvingUid: string | null
  savingAggressiveness: boolean
  onCopyCode: () => void
  onApproveMember: (member: Member) => void
  onRejectMember: (member: Member) => void
  onAggressivenessChange: (level: AgentAggressiveness) => void
  onError: (msg: string) => void
  onToast: (msg: string, tone?: "success" | "error") => void
}) {
  const [invitePanelOpen, setInvitePanelOpen] = useState(false)
  const [inviteExpiryHours, setInviteExpiryHours] = useState<24 | 48 | 168>(24)
  const [inviteMaxUses, setInviteMaxUses] = useState("10")
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null)
  const [latestInviteUrl, setLatestInviteUrl] = useState("")

  const handleCreateTemporaryInvite = async (event: FormEvent) => {
    event.preventDefault()
    if (!user || creatingInvite) return
    const parsedMax = Number.parseInt(inviteMaxUses, 10)
    const maxUses = Number.isFinite(parsedMax) ? Math.max(1, Math.min(1000, parsedMax)) : 10

    setCreatingInvite(true)
    onError("")
    try {
      const { url } = await createTemporaryInvite(activeRoom.code, user, {
        expiresInHours: inviteExpiryHours,
        maxUses,
      })
      setLatestInviteUrl(url)
      await navigator.clipboard?.writeText(url).catch(() => {})
      onToast("Temporary invite link created & copied")
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not create temporary invite.")
      onError(friendly)
      onToast(friendly, "error")
    } finally {
      setCreatingInvite(false)
    }
  }

  const handleCopyTempInvite = async (invId: string) => {
    const url = new URL(
      `/join?invite=${encodeURIComponent(invId)}&room=${encodeURIComponent(activeRoom.code)}`,
      window.location.origin
    ).toString()
    await navigator.clipboard?.writeText(url).catch(() => {})
    onToast("Temporary invite link copied")
  }

  const handleRevokeInvite = async (invId: string) => {
    if (revokingInviteId) return
    setRevokingInviteId(invId)
    try {
      await revokeInvite(activeRoom.code, invId)
      onToast("Invite link revoked")
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not revoke invite link.")
      onToast(friendly, "error")
    } finally {
      setRevokingInviteId(null)
    }
  }

  return (
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
          onClick={onCopyCode}
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
              Members <span>{approvedMembers.length}</span>
              {pendingMembers.length > 0 && (
                <span className="pending-count-pill">{pendingMembers.length} pending</span>
              )}
            </h3>
          </div>
          <button onClick={onCopyCode} aria-label="Invite a teammate">
            <Plus size={15} />
          </button>
        </div>
        <div className="member-list">
          <div className="member-row is-agent" key="__cohort_agent__">
            <span className="member-avatar bot-avatar">
              <Bot size={13} />
            </span>
            <span className="member-name">
              @cohort <small className="agent-tag">AI</small>
            </span>
            <span className={`member-status ${agentThinkingNow ? "thinking" : "watching"}`}>
              {agentThinkingNow ? "thinking…" : "watching"}
            </span>
          </div>
          {members.map((member) => {
            const isPending = member.role === "pending"
            const onlineNow = !isPending && isMemberOnline(member, nowMs)
            const isUpdatingMember = approvingUid === member.uid
            return (
              <div className={`member-row ${isPending ? "is-pending" : ""}`} key={member.uid}>
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
                  {member.role === "owner" && <small className="owner-tag">owner</small>}
                </span>
                {isPending ? (
                  <div className="pending-member-controls">
                    <span className="member-pending-badge">Pending</span>
                    {isOwner && (
                      <div className="owner-approval-actions">
                        <button
                          type="button"
                          className="approve-btn"
                          onClick={() => onApproveMember(member)}
                          disabled={isUpdatingMember}
                          aria-label={`Approve ${member.name}`}
                          title="Approve"
                        >
                          {isUpdatingMember ? (
                            <LoaderCircle className="spin" size={11} />
                          ) : (
                            <UserCheck size={12} />
                          )}
                          <span>Approve</span>
                        </button>
                        <button
                          type="button"
                          className="reject-btn"
                          onClick={() => onRejectMember(member)}
                          disabled={isUpdatingMember}
                          aria-label={`Reject ${member.name}`}
                          title="Reject"
                        >
                          <UserX size={12} />
                          <span>Reject</span>
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <span className={`member-status ${onlineNow ? "online" : ""}`}>
                    {formatMemberLastSeen(member, nowMs)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <button className="invite-link" onClick={onCopyCode}>
          <Users size={15} /> Copy room code ({activeRoom.code}) <ArrowRight size={14} />
        </button>

        {isOwner && (
          <div className="owner-invites-section">
            <div className="owner-invites-header">
              <button
                type="button"
                className="create-temp-invite-btn"
                onClick={() => setInvitePanelOpen(!invitePanelOpen)}
                aria-expanded={invitePanelOpen}
              >
                <Link2 size={13} />
                <span>Create temporary invite</span>
                <ChevronDown size={13} className={invitePanelOpen ? "rotated" : ""} />
              </button>
            </div>

            {invitePanelOpen && (
              <form className="temp-invite-form" onSubmit={handleCreateTemporaryInvite}>
                <div className="temp-invite-field">
                  <span className="temp-invite-label">Expires in</span>
                  <div className="expiry-pills" role="group" aria-label="Invite expiration">
                    {([
                      { hours: 24, label: "24h" },
                      { hours: 48, label: "48h" },
                      { hours: 168, label: "7 days" },
                    ] as const).map((option) => (
                      <button
                        key={option.hours}
                        type="button"
                        className={inviteExpiryHours === option.hours ? "active" : ""}
                        onClick={() => setInviteExpiryHours(option.hours)}
                        disabled={creatingInvite}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="temp-invite-row">
                  <label className="temp-invite-uses-label">
                    <span>Max uses</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={inviteMaxUses}
                      onChange={(e) => setInviteMaxUses(e.target.value)}
                      disabled={creatingInvite}
                    />
                  </label>
                  <button
                    type="submit"
                    className="generate-invite-submit"
                    disabled={creatingInvite}
                  >
                    {creatingInvite ? (
                      <LoaderCircle className="spin" size={13} />
                    ) : (
                      <>
                        <ShieldCheck size={13} /> Create &amp; copy
                      </>
                    )}
                  </button>
                </div>

                {latestInviteUrl && (
                  <div className="latest-invite-box">
                    <input
                      type="text"
                      readOnly
                      value={latestInviteUrl}
                      aria-label="Latest temporary invite URL"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(latestInviteUrl)
                        onToast("Temporary invite link copied")
                      }}
                      aria-label="Copy temporary invite link"
                    >
                      <Clipboard size={12} />
                    </button>
                  </div>
                )}
              </form>
            )}

            {invites.length > 0 && (
              <div className="invite-history-list">
                <span className="invite-history-title">
                  Temporary invites ({invites.length})
                </span>
                {invites.slice(0, 4).map((inv) => {
                  const expiresMs = Date.parse(inv.expiresAt)
                  const isExpired = Number.isNaN(expiresMs) || expiresMs <= nowMs
                  const isMaxed = inv.usedCount >= inv.maxUses
                  const isUsable = inv.active && !isExpired && !isMaxed
                  const statusText = !inv.active
                    ? "Revoked"
                    : isExpired
                      ? "Expired"
                      : isMaxed
                        ? "Limit reached"
                        : "Active"
                  return (
                    <div className={`invite-item-row ${isUsable ? "" : "is-inactive"}`} key={inv.id}>
                      <div className="invite-item-meta">
                        <span className={`invite-status-pill ${isUsable ? "is-active" : ""}`}>
                          {statusText}
                        </span>
                        <span className="invite-usage">
                          {inv.usedCount}/{inv.maxUses} uses
                        </span>
                      </div>
                      <div className="invite-item-actions">
                        {isUsable && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleCopyTempInvite(inv.id)}
                              title="Copy invite link"
                              aria-label="Copy invite link"
                            >
                              <Clipboard size={12} />
                            </button>
                            <button
                              type="button"
                              className="revoke-btn"
                              onClick={() => void handleRevokeInvite(inv.id)}
                              disabled={revokingInviteId === inv.id}
                              title="Revoke invite"
                              aria-label="Revoke invite"
                            >
                              <Ban size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="agent-card">
        <div className="agent-card-top">
          <div className="agent-icon">
            <Bot size={17} />
          </div>
          <div>
            <strong>
              Your teammate, @cohort{" "}
              <span className={`agent-card-state ${agentThinkingNow ? "thinking" : ""}`}>
                · {agentThinkingNow ? "thinking…" : "watching"}
              </span>
            </strong>
            <p>Watches blockers &amp; deadlines automatically, or tag @cohort anytime.</p>
          </div>
          <span className="agent-spark">✳</span>
        </div>
        <div className="agent-proactivity">
          <div className="agent-proactivity-head">
            <span>Proactivity</span>
            <small>{PROACTIVE_THRESHOLDS[activeRoom.agentAggressiveness].description}</small>
          </div>
          <div className="agent-proactivity-pills" role="group" aria-label="@cohort proactivity level">
            {(["low", "medium", "high"] as const).map((level) => {
              const activeLevel = activeRoom.agentAggressiveness === level
              return (
                <button
                  key={level}
                  type="button"
                  className={activeLevel ? "active" : ""}
                  disabled={!isOwner || savingAggressiveness}
                  onClick={() => onAggressivenessChange(level)}
                  title={
                    isOwner
                      ? PROACTIVE_THRESHOLDS[level].description
                      : "Only the room owner can change @cohort proactivity"
                  }
                >
                  {PROACTIVE_THRESHOLDS[level].label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </aside>
  )
}

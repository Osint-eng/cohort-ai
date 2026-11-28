"use client"

import { ArrowRight, Clock, Hash, LoaderCircle, UserX } from "lucide-react"
import { formatRetryAfterTime, type RoomMeta } from "@/lib/api"
import "@/app/styles/room-shell.css"

export function RoomNotFoundView() {
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

export function SessionLoadingView({ authLoading }: { authLoading: boolean }) {
  return (
    <main className="room-state-screen">
      <div className="room-loading" role="status">
        <LoaderCircle className="spin" size={20} />{" "}
        {authLoading ? "Checking session…" : "Opening room…"}
      </div>
    </main>
  )
}

export function RejectedCooldownView({
  roomCode,
  rejectedUntilIso,
}: {
  roomCode: string
  rejectedUntilIso: string | null
}) {
  return (
    <main className="room-state-screen">
      <section className="room-state-card">
        <div className="room-state-icon is-declined">
          <UserX size={24} />
        </div>
        <p className="eyebrow">ACCESS DECLINED</p>
        <h1>Join request declined</h1>
        <p>
          The owner of room <strong>{roomCode}</strong> declined your request to join.
          {rejectedUntilIso
            ? ` You can ask again after ${formatRetryAfterTime(rejectedUntilIso)}.`
            : ""}
        </p>
        <a className="primary-button" href="/join">
          Back to join page <ArrowRight size={16} />
        </a>
      </section>
    </main>
  )
}

export function PendingApprovalView({
  roomMeta,
  onCancelRequest,
  onSignOut,
}: {
  roomMeta: RoomMeta
  onCancelRequest: () => void
  onSignOut: () => void
}) {
  return (
    <main className="room-state-screen">
      <section className="room-state-card pending-approval-card" aria-live="polite">
        <div className="room-state-icon pending-approval-icon">
          <Clock size={24} />
        </div>
        <p className="eyebrow">
          <span className="pending-dot" /> JOIN REQUEST PENDING
        </p>
        <h1>Waiting for approval</h1>
        <p className="pending-main-message">
          Waiting for the room owner to approve your join request
        </p>
        <div className="pending-room-pill">
          <span>{roomMeta.title}</span>
          <code>#{roomMeta.code}</code>
        </div>
        <p className="pending-subnote">
          This room will unlock automatically in real time as soon as the owner approves you.
        </p>
        <div className="pending-actions">
          <button type="button" className="secondary-btn" onClick={onCancelRequest}>
            Cancel request
          </button>
          <button type="button" className="secondary-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </section>
    </main>
  )
}

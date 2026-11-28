"use client"

import type { FormEvent } from "react"
import type { User } from "firebase/auth"
import {
  AlertCircle,
  ArrowRight,
  FileText,
  Hash,
  Link2,
  LoaderCircle,
  LogIn,
  MessageCircle,
  Moon,
  Sun,
  Users,
} from "lucide-react"
import { suggestDefaultRoomTitle } from "@/lib/api"
import { initials } from "./ui-helpers"
import "@/app/styles/join.css"

export default function JoinRoomScreen({
  mode,
  normalizedRouteCode,
  roomCode,
  projectTitle,
  user,
  currentUserName,
  signingIn,
  joining,
  dark,
  error,
  activeInviteId,
  inviteCheckStatus,
  inviteRemainingUses,
  onToggleTheme,
  onGoogleSignIn,
  onSignOut,
  onEnterRoom,
  onRoomCodeChange,
  onProjectTitleChange,
  onClearInvite,
}: {
  mode: "join" | "room"
  normalizedRouteCode: string
  roomCode: string
  projectTitle: string
  user: User | null
  currentUserName: string
  signingIn: boolean
  joining: boolean
  dark: boolean
  error: string
  activeInviteId: string
  inviteCheckStatus: "idle" | "checking" | "valid" | "invalid"
  inviteRemainingUses: number | null
  onToggleTheme: () => void
  onGoogleSignIn: () => void
  onSignOut: () => void
  onEnterRoom: (event: FormEvent) => void
  onRoomCodeChange: (value: string) => void
  onProjectTitleChange: (value: string) => void
  onClearInvite: () => void
}) {
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
          onClick={onToggleTheme}
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
            : activeInviteId && roomCode
              ? user
                ? `Accept your temporary invite to join room ${roomCode}.`
                : `You’ve been invited to room ${roomCode}. Sign in with Google to continue.`
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
              onClick={onGoogleSignIn}
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
          <form onSubmit={onEnterRoom} className="join-form">
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
              <button type="button" className="signout-chip" onClick={onSignOut}>
                Sign out
              </button>
            </div>

            {user.emailVerified === false && (
              <div className="verified-warning" role="alert">
                <strong>Verified Google email required</strong>
                Your account ({user.email || "Google user"}) does not report a verified email. Please sign in with a verified Google account to create or join rooms.
              </div>
            )}

            {mode === "join" && activeInviteId && (
              <div
                className={`invite-banner ${inviteCheckStatus === "invalid" ? "is-invalid" : ""}`}
                role={inviteCheckStatus === "invalid" ? "alert" : undefined}
              >
                <div className="invite-banner-copy">
                  <span className="invite-banner-icon">
                    {inviteCheckStatus === "invalid" ? <AlertCircle size={15} /> : <Link2 size={15} />}
                  </span>
                  <div>
                    <strong>
                      {inviteCheckStatus === "invalid"
                        ? "Invite unavailable"
                        : `Temporary invite to ${roomCode || normalizedRouteCode}`}
                    </strong>
                    <span>
                      {inviteCheckStatus === "checking"
                        ? "Checking invite validity…"
                        : inviteCheckStatus === "invalid"
                          ? "This invite link has expired or reached its limit"
                          : inviteRemainingUses !== null
                            ? `${inviteRemainingUses} use${inviteRemainingUses === 1 ? "" : "s"} left · Owner approval required`
                            : "Owner approval required after joining"}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="invite-banner-clear"
                  onClick={onClearInvite}
                >
                  Use code instead
                </button>
              </div>
            )}

            {mode === "join" && (
              <label>
                Room code <span className="optional">TO JOIN AN EXISTING ROOM</span>
                <div className="input-wrap">
                  <Hash size={16} />
                  <input
                    value={roomCode}
                    onChange={(event) => onRoomCodeChange(event.target.value)}
                    placeholder="Leave blank to create, or enter 8-char code"
                    maxLength={8}
                    autoCapitalize="characters"
                    disabled={joining}
                    readOnly={Boolean(activeInviteId && inviteCheckStatus !== "invalid")}
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
                    onChange={(event) => onProjectTitleChange(event.target.value)}
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
              disabled={
                joining ||
                user.emailVerified === false ||
                (Boolean(activeInviteId) &&
                  (inviteCheckStatus === "invalid" || inviteCheckStatus === "checking"))
              }
            >
              {joining ? (
                <>
                  <LoaderCircle className="spin" size={17} />
                  {roomCode.trim() ? "Requesting access…" : "Creating room…"}
                </>
              ) : activeInviteId && roomCode.trim() ? (
                <>
                  Accept invite &amp; join room <ArrowRight size={17} />
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

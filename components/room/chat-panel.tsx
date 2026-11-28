"use client"

import { useEffect, useState, type FormEvent, type RefObject } from "react"
import {
  ArrowRight,
  Bot,
  CircleHelp,
  Hash,
  LoaderCircle,
  Send,
  Sparkles,
  X,
} from "lucide-react"
import type { Member, Message } from "@/lib/api"
import { colorIndexForId, colors, commands, initials, relativeTime } from "./ui-helpers"
import "@/app/styles/chat.css"

export default function ChatPanel({
  activeTab,
  messagesContainerRef,
  hasMoreMessages,
  loadingOlderMessages,
  messages,
  members,
  cohortThinking,
  error,
  message,
  taskCount,
  extractOpen,
  extracting,
  onLoadOlderMessages,
  onDismissError,
  onMessageChange,
  onSendMessage,
  onFillCommand,
  onOpenExtractModal,
  onCloseExtractModal,
  onSubmitExtract,
}: {
  activeTab: string
  messagesContainerRef: RefObject<HTMLDivElement | null>
  hasMoreMessages: boolean
  loadingOlderMessages: boolean
  messages: Message[]
  members: Member[]
  cohortThinking: boolean
  error: string
  message: string
  taskCount: number
  extractOpen: boolean
  extracting: boolean
  onLoadOlderMessages: () => void
  onDismissError: () => void
  onMessageChange: (value: string) => void
  onSendMessage: (event?: FormEvent) => void
  onFillCommand: (command: string) => void
  onOpenExtractModal: () => void
  onCloseExtractModal: () => void
  onSubmitExtract: (params: {
    brief: string
    extractMode: "merge" | "replace"
    replaceConfirmed: boolean
  }) => Promise<boolean>
}) {
  const [brief, setBrief] = useState("")
  const [extractMode, setExtractMode] = useState<"merge" | "replace">("merge")
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)

  useEffect(() => {
    if (extractOpen) {
      setExtractMode("merge")
      setReplaceConfirmed(false)
    }
  }, [extractOpen])

  const handleSubmitExtract = async (event: FormEvent) => {
    event.preventDefault()
    if (!brief.trim() || extracting) return
    const ok = await onSubmitExtract({
      brief,
      extractMode,
      replaceConfirmed,
    })
    if (ok) {
      setBrief("")
      setReplaceConfirmed(false)
      setExtractMode("merge")
    }
  }

  return (
    <>
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
            onClick={onOpenExtractModal}
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
          {hasMoreMessages && (
            <div className="flex justify-center pb-1">
              <button
                type="button"
                className="quick-status-btn flex-none px-3"
                onClick={onLoadOlderMessages}
                disabled={loadingOlderMessages}
              >
                {loadingOlderMessages ? "Loading older messages…" : "Load older messages"}
              </button>
            </div>
          )}
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
            <button onClick={onDismissError} aria-label="Dismiss error">
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
              <button key={command} type="button" onClick={() => onFillCommand(command)}>
                {command.replace("@cohort ", "")}
              </button>
            ))}
          </div>
          <form className="composer" onSubmit={onSendMessage}>
            <input
              id="chat-input"
              value={message}
              onChange={(event) => onMessageChange(event.target.value)}
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
            <button type="button" onClick={onOpenExtractModal}>
              Extract brief <CircleHelp size={12} />
            </button>
          </p>
        </div>
      </section>

      {extractOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !extracting) onCloseExtractModal()
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
              onClick={onCloseExtractModal}
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
            <form onSubmit={(e) => void handleSubmitExtract(e)}>
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
              {taskCount > 0 && (
                <div className="extract-mode-box">
                  <span className="extract-mode-title">
                    Board already has {taskCount} task{taskCount === 1 ? "" : "s"}
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
                      <span>Clear current {taskCount} tasks and start fresh</span>
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
                      <span>
                        I understand this will delete the {taskCount} existing tasks and their current progress.
                      </span>
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
                    (taskCount > 0 && extractMode === "replace" && !replaceConfirmed)
                  }
                >
                  {extracting ? (
                    <>
                      <LoaderCircle className="spin" size={15} /> Extracting…
                    </>
                  ) : (
                    <>
                      {taskCount > 0 && extractMode === "merge" ? "Add to board" : "Build my board"}{" "}
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
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

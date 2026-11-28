"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Download,
  Scale,
} from "lucide-react"
import type { LogEntry, Member, Task } from "@/lib/api"
import {
  buildFairnessCsv,
  computeFairnessReport,
  INACTIVE_THRESHOLD_HOURS,
} from "@/lib/fairness"
import "@/app/styles/fairness.css"

function formatRelativeAge(ts: string | null): string {
  if (!ts) return "No actions yet"
  const parsed = Date.parse(ts)
  if (Number.isNaN(parsed)) return "No actions yet"
  const mins = Math.max(0, Math.floor((Date.now() - parsed) / 60_000))
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  )
}

export default function FairnessDashboard({
  roomCode,
  roomTitle,
  members,
  tasks,
  logs,
  nowMs,
  onToast,
}: {
  roomCode: string
  roomTitle: string
  members: Member[]
  tasks: Task[]
  logs: LogEntry[]
  nowMs: number
  onToast: (msg: string) => void
}) {
  const [selectedUid, setSelectedUid] = useState<string>("all")

  const report = useMemo(
    () => computeFairnessReport({ members, tasks, logs, nowMs }),
    [members, tasks, logs, nowMs]
  )

  const filteredTimeline = useMemo(() => {
    if (selectedUid === "all") return report.timeline
    return report.timeline.filter((entry) => entry.actorId === selectedUid)
  }, [report.timeline, selectedUid])

  const maxDailyTotal = useMemo(
    () => Math.max(1, ...report.dailyBuckets.map((b) => b.total)),
    [report.dailyBuckets]
  )

  const handleExportCsv = () => {
    const csv = buildFairnessCsv(roomCode, roomTitle, report)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `fairness-report-${roomCode.toLowerCase()}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    onToast("Contribution report exported (CSV)")
  }

  const selectedMemberName =
    selectedUid === "all"
      ? "All members"
      : report.members.find((m) => m.member.uid === selectedUid)?.member.name || "Member"

  return (
    <div className="fairness-view">
      <div className="fairness-top-bar">
        <div className="fairness-heading-copy">
          <h3>Fairness &amp; Contribution</h3>
          <p>
            Aggregated in real time from room tasks and activity logs ·{" "}
            <span className="tabular-nums">{report.members.length}</span> active members
          </p>
        </div>
        <button
          type="button"
          className="fairness-export-btn"
          onClick={handleExportCsv}
          disabled={report.members.length === 0}
        >
          <Download size={13} />
          Export CSV
        </button>
      </div>

      {/* 1. Summary KPI Strip */}
      <div className="fairness-kpi-grid">
        <div className="fairness-kpi-card">
          <div className="kpi-label">
            <Scale size={13} />
            <span>Team Fairness Score</span>
          </div>
          <div className="kpi-value tabular-nums">
            {report.fairnessScore !== null ? `${report.fairnessScore}/100` : "—"}
          </div>
          <div className={`kpi-sub ${report.fairnessLabel.toLowerCase().replace(/\s+/g, "-")}`}>
            {report.fairnessLabel} · Target ~{report.targetSharePercent}% each
          </div>
        </div>

        <div className="fairness-kpi-card">
          <div className="kpi-label">
            <CheckCircle2 size={13} />
            <span>Completed Tasks</span>
          </div>
          <div className="kpi-value tabular-nums">
            {report.completedTasks}/{report.totalTasks}
          </div>
          <div className="kpi-sub tabular-nums">
            {report.totalTasks > 0
              ? `${Math.round((report.completedTasks / report.totalTasks) * 100)}% complete · ${report.inProgressTasks} active`
              : "Extract or add tasks to track"}
          </div>
        </div>

        <div className="fairness-kpi-card">
          <div className="kpi-label">
            <AlertTriangle size={13} />
            <span>Blocked</span>
          </div>
          <div className="kpi-value tabular-nums">{report.blockedTasks}</div>
          <div className={`kpi-sub ${report.blockedTasks > 0 ? "has-warning" : ""}`}>
            {report.blockedTasks > 0
              ? `${report.blockedMembersCount} member${report.blockedMembersCount === 1 ? "" : "s"} blocked`
              : "No blocked tasks right now"}
          </div>
        </div>

        <div className="fairness-kpi-card">
          <div className="kpi-label">
            <Clock size={13} />
            <span>Inactive ({INACTIVE_THRESHOLD_HOURS}h+)</span>
          </div>
          <div className="kpi-value tabular-nums">{report.inactiveMembersCount}</div>
          <div className={`kpi-sub ${report.inactiveMembersCount > 0 ? "has-warning" : ""}`}>
            {report.inactiveMembersCount > 0
              ? "Needs check-in or task handoff"
              : "All teammates active"}
          </div>
        </div>
      </div>

      {/* 2. Summary Charts: Workload Share Balance & 7-Day Activity */}
      <div className="fairness-charts-grid">
        <section className="fairness-card" aria-label="Contribution share comparison">
          <div className="fairness-card-head">
            <h4>Contribution Balance vs. Equal Share</h4>
            <span className="tabular-nums">Target {report.targetSharePercent}%</span>
          </div>
          {report.members.length === 0 ? (
            <p className="fairness-empty-note">No approved members in this room yet.</p>
          ) : (
            <div className="share-bars-list">
              {report.members.map((row) => (
                <div className="share-bar-row" key={row.member.uid}>
                  <div className="share-bar-label">
                    <span className="share-member-name">{row.member.name}</span>
                    <span className="share-member-nums tabular-nums">
                      {row.sharePercent}% · {row.points} pts
                    </span>
                  </div>
                  <div className="share-track">
                    <div
                      className={`share-fill ${
                        row.blockedCount > 0
                          ? "is-blocked"
                          : row.isInactive
                            ? "is-inactive"
                            : "is-nominal"
                      }`}
                      style={{ width: `${Math.min(100, row.sharePercent)}%` }}
                    />
                    {report.targetSharePercent > 0 && (
                      <span
                        className="share-target-line"
                        style={{ left: `${Math.min(98, report.targetSharePercent)}%` }}
                        title={`Equal share target: ${report.targetSharePercent}%`}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="fairness-card" aria-label="7-day activity timeline chart">
          <div className="fairness-card-head">
            <h4>
              <BarChart3 size={13} /> 7-Day Activity Cadence
            </h4>
            <span className="tabular-nums">{report.totalLogs} logged actions</span>
          </div>
          <div className="cadence-chart-wrap">
            <svg
              viewBox="0 0 280 118"
              className="cadence-svg"
              role="img"
              aria-label="Daily task contributions over the last 7 days"
            >
              {report.dailyBuckets.map((bucket, idx) => {
                const slotWidth = 280 / report.dailyBuckets.length
                const barWidth = 22
                const x = idx * slotWidth + (slotWidth - barWidth) / 2
                const maxBarHeight = 76
                const totalHeight =
                  bucket.total > 0
                    ? Math.max(6, Math.round((bucket.total / maxDailyTotal) * maxBarHeight))
                    : 2
                const compHeight =
                  bucket.total > 0
                    ? Math.round((bucket.completions / bucket.total) * totalHeight)
                    : 0
                const updHeight = Math.max(0, totalHeight - compHeight)
                const yBottom = 92

                return (
                  <g key={bucket.dateKey}>
                    <rect
                      x={x}
                      y={yBottom - totalHeight}
                      width={barWidth}
                      height={updHeight}
                      rx={3}
                      className="cadence-bar-updates"
                    />
                    {compHeight > 0 && (
                      <rect
                        x={x}
                        y={yBottom - compHeight}
                        width={barWidth}
                        height={compHeight}
                        rx={3}
                        className="cadence-bar-done"
                      />
                    )}
                    {bucket.total > 0 && (
                      <text
                        x={x + barWidth / 2}
                        y={yBottom - totalHeight - 5}
                        textAnchor="middle"
                        className="cadence-count-text"
                      >
                        {bucket.total}
                      </text>
                    )}
                    <text
                      x={x + barWidth / 2}
                      y={109}
                      textAnchor="middle"
                      className="cadence-day-text"
                    >
                      {bucket.label.split(" ")[1] || bucket.label}
                    </text>
                  </g>
                )
              })}
            </svg>
            <div className="cadence-legend">
              <span>
                <i className="legend-swatch done" /> Completed
              </span>
              <span>
                <i className="legend-swatch updates" /> Progress / updates
              </span>
            </div>
          </div>
        </section>
      </div>

      {/* 3. Detailed Per-Member Breakdown */}
      <section className="fairness-card" aria-label="Per-member contribution breakdown">
        <div className="fairness-card-head">
          <h4>Per-Member Breakdown</h4>
          <span>
            Click a member to filter timeline{report.unassignedTasksCount > 0 ? ` · ${report.unassignedTasksCount} unassigned` : ""}
          </span>
        </div>
        <div className="fairness-table-wrap">
          <table className="fairness-table">
            <thead>
              <tr>
                <th>Member</th>
                <th className="num">Done</th>
                <th className="num">Active</th>
                <th className="num">Blocked</th>
                <th className="num">Logs</th>
                <th>Last Activity</th>
                <th className="num">Share</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {report.members.map((row) => {
                const isSelected = selectedUid === row.member.uid
                return (
                  <tr
                    key={row.member.uid}
                    className={isSelected ? "is-selected" : ""}
                    onClick={() =>
                      setSelectedUid(isSelected ? "all" : row.member.uid)
                    }
                  >
                    <td>
                      <div className="fairness-member-cell">
                        <span className="fairness-avatar">
                          {row.member.photoURL ? (
                            <img
                              src={row.member.photoURL}
                              alt={row.member.name}
                              className="avatar-img"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            initials(row.member.name)
                          )}
                        </span>
                        <div className="fairness-member-meta">
                          <strong>{row.member.name}</strong>
                          <span>{row.assignedCount} assigned</span>
                        </div>
                      </div>
                    </td>
                    <td className="num tabular-nums">{row.completedCount}</td>
                    <td className="num tabular-nums">{row.inProgressCount}</td>
                    <td className={`num tabular-nums ${row.blockedCount > 0 ? "cell-warn" : ""}`}>
                      {row.blockedCount}
                    </td>
                    <td className="num tabular-nums">{row.logActionsCount}</td>
                    <td className={row.isInactive ? "cell-warn" : ""}>
                      {formatRelativeAge(row.lastContributionAt)}
                    </td>
                    <td className="num tabular-nums">{row.sharePercent}%</td>
                    <td>
                      <span
                        className={`fairness-status-text is-${row.statusFlag
                          .toLowerCase()
                          .replace(/\s+/g, "-")}`}
                      >
                        {row.statusFlag}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {report.members.length === 0 && (
                <tr>
                  <td colSpan={8} className="fairness-empty-cell">
                    No approved members found yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Contribution Timeline */}
      <section className="fairness-card" aria-label="Contribution timeline">
        <div className="fairness-card-head">
          <h4>Contribution Timeline · {selectedMemberName}</h4>
          <div className="timeline-filter-tabs" role="group" aria-label="Filter timeline by member">
            <button
              type="button"
              className={selectedUid === "all" ? "active" : ""}
              onClick={() => setSelectedUid("all")}
            >
              All
            </button>
            {report.members.map((row) => (
              <button
                key={row.member.uid}
                type="button"
                className={selectedUid === row.member.uid ? "active" : ""}
                onClick={() => setSelectedUid(row.member.uid)}
              >
                {row.member.name.split(/\s+/)[0]}
              </button>
            ))}
          </div>
        </div>

        {filteredTimeline.length === 0 ? (
          <p className="fairness-empty-note">
            No member task actions recorded yet for this filter. Updating task statuses or reassigning tasks logs contributions automatically.
          </p>
        ) : (
          <div className="fairness-timeline-list">
            {filteredTimeline.slice(0, 25).map((entry) => (
              <div className="fairness-timeline-row" key={entry.id}>
                <span className={`timeline-action-tag is-${entry.action.replace(/\s+/g, "-")}`}>
                  {entry.action}
                </span>
                <div className="fairness-timeline-body">
                  <p>
                    <strong>{entry.actor}</strong>{" "}
                    <span className="task-id">{entry.task_id}</span>
                    {entry.note ? ` — ${entry.note}` : ""}
                  </p>
                </div>
                <time className="tabular-nums">{formatRelativeAge(entry.ts)}</time>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="fairness-formula-note">
        Formula: Fairness Score uses Jain’s Evenness Index over activity-log points (+3 × task weight 1–3 for the first completion per task, +1 for the first start per task, repeated toggles add 0, and other actions capped at 2 pts). Zero extra Firestore reads — derived live from subscribed tasks and logs.
      </p>
    </div>
  )
}

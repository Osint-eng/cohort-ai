"use client"

import { useState, type FormEvent } from "react"
import dynamic from "next/dynamic"
import type { User } from "firebase/auth"
import {
  AlertCircle,
  ArrowDown,
  ArrowUpRight,
  Bot,
  Check,
  FileCode2,
  LayoutGrid,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Scale,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import {
  createTaskFirestore,
  formatTaskDueDateDisplay,
  getFriendlyErrorMessage,
  getTodayDateInputValue,
  normalizeTaskWeight,
  toDueDateInputValue,
  updateTaskFieldsFirestore,
  type LogEntry,
  type Member,
  type RoomMeta,
  type Task,
  type TaskStatus,
  type TaskType,
  type TaskWeight,
} from "@/lib/api"
import { getTaskSandboxMeta } from "@/lib/task-sandbox"
import { initials, statusColumns } from "./ui-helpers"
import "@/app/styles/board.css"

const FairnessDashboard = dynamic(() => import("@/components/fairness-dashboard"), {
  ssr: false,
  loading: () => (
    <div className="empty-board" role="status">
      <LoaderCircle className="spin" size={20} />
      <p>Loading fairness dashboard…</p>
    </div>
  ),
})

const TaskSandboxModal = dynamic(() => import("@/components/task-sandbox-modal"), {
  ssr: false,
})

function resolveInitialOwnerUid(
  modalMode: "create" | "edit",
  editingTask: Task | null,
  approvedMembers: Member[],
  currentUserUid?: string
): string {
  if (modalMode === "create") {
    const selfMember = approvedMembers.find((m) => m.uid === currentUserUid)
    return selfMember?.uid || approvedMembers[0]?.uid || ""
  }
  if (!editingTask) return ""
  if (editingTask.owner_uid && approvedMembers.some((m) => m.uid === editingTask.owner_uid)) {
    return editingTask.owner_uid
  }
  const cleanHandle = editingTask.suggested_owner.replace(/^@/, "").trim().toLowerCase()
  if (cleanHandle && cleanHandle !== "team") {
    const matched = approvedMembers.find(
      (m) =>
        m.name.toLowerCase() === cleanHandle ||
        m.name.split(/\s+/)[0]?.toLowerCase() === cleanHandle
    )
    if (matched) return matched.uid
  }
  return ""
}

export default function BoardPanel({
  activeRoom,
  user,
  activeTab,
  view,
  tasks,
  fileCount = 0,
  approvedMembers,
  mergedFairnessLogs,
  nowMs,
  updatingTaskId,
  onSetView,
  onSwitchToFiles,
  onRunCheckIn,
  onOpenExtractModal,
  onChangeTaskStatus,
  onChangeTaskOwner,
  onDeleteTask,
  onToast,
}: {
  activeRoom: RoomMeta
  user: User | null
  activeTab: string
  view: "board" | "table" | "fairness"
  tasks: Task[]
  fileCount?: number
  approvedMembers: Member[]
  mergedFairnessLogs: LogEntry[]
  nowMs: number
  updatingTaskId: string | null
  onSetView: (view: "board" | "table" | "fairness") => void
  onSwitchToFiles?: () => void
  onRunCheckIn: () => void
  onOpenExtractModal: () => void
  onChangeTaskStatus: (task: Task, status: TaskStatus) => void
  onChangeTaskOwner: (task: Task, member: Member) => void
  onDeleteTask: (task: Task) => void
  onToast: (msg: string, tone?: "success" | "error") => void
}) {
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null)
  const [sandboxTaskId, setSandboxTaskId] = useState<string | null>(null)
  const [taskModalMode, setTaskModalMode] = useState<"create" | "edit" | null>(null)
  const [editingTask, setEditingTask] = useState<Task | null>(null)

  const sandboxTask = sandboxTaskId ? tasks.find((t) => t.id === sandboxTaskId) || null : null

  const openCreateTaskModal = () => {
    setEditingTask(null)
    setTaskMenuId(null)
    setTaskModalMode("create")
  }

  const openEditTaskModal = (task: Task) => {
    setEditingTask(task)
    setTaskMenuId(null)
    setTaskModalMode("edit")
  }

  const closeTaskModal = () => {
    setTaskModalMode(null)
    setEditingTask(null)
  }

  return (
    <>
      <section
        className={`panel board-panel ${activeTab !== "Board" ? "mobile-hidden" : ""}`}
        aria-label="Project board"
      >
        <div className="panel-header board-header">
          {onSwitchToFiles ? (
            <div className="center-panel-tabs" role="tablist" aria-label="Center workspace">
              <button type="button" role="tab" aria-selected={true} className="active">
                <LayoutGrid size={13} />
                Board <span className="task-count">{tasks.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={false} onClick={onSwitchToFiles}>
                <FileCode2 size={13} />
                Files <span className="task-count">{fileCount}</span>
              </button>
            </div>
          ) : (
            <div>
              <h2>
                Board <span className="task-count">{tasks.length}</span>
              </h2>
            </div>
          )}
          <button
            className="icon-button small-icon"
            aria-label="Run AI check-in"
            onClick={onRunCheckIn}
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
          <button aria-label="Extract board from brief" onClick={onOpenExtractModal}>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="board-toolbar">
          <div className="view-toggle" role="group" aria-label="Board display mode">
            <button
              type="button"
              onClick={() => onSetView("board")}
              className={view === "board" ? "active" : ""}
              aria-label="Kanban view"
            >
              <LayoutGrid size={14} />
              <span>Board</span>
            </button>
            <button
              type="button"
              onClick={() => onSetView("table")}
              className={view === "table" ? "active" : ""}
              aria-label="Table view"
            >
              <List size={14} />
              <span>Table</span>
            </button>
            <button
              type="button"
              onClick={() => onSetView("fairness")}
              className={view === "fairness" ? "active" : ""}
              aria-label="Fairness and contribution view"
            >
              <Scale size={14} />
              <span>Fairness</span>
            </button>
          </div>
          <div className="board-toolbar-actions">
            <button type="button" className="add-task-button" onClick={openCreateTaskModal}>
              <Plus size={14} /> Add task
            </button>
            <button type="button" className="extract-button" onClick={onOpenExtractModal}>
              <Sparkles size={14} /> Extract board
            </button>
          </div>
        </div>

        {view === "fairness" ? (
          <FairnessDashboard
            roomCode={activeRoom.code}
            roomTitle={activeRoom.title}
            members={approvedMembers}
            tasks={tasks}
            logs={mergedFairnessLogs}
            nowMs={nowMs}
            onToast={onToast}
          />
        ) : tasks.length ? (
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
                          members={approvedMembers}
                          nowMs={nowMs}
                          menuOpen={taskMenuId === task.id}
                          updating={updatingTaskId === task.id}
                          onToggleMenu={() =>
                            setTaskMenuId(taskMenuId === task.id ? null : task.id)
                          }
                          onStatusChange={(status) => {
                            setTaskMenuId(null)
                            onChangeTaskStatus(task, status)
                          }}
                          onReassign={(member) => {
                            setTaskMenuId(null)
                            onChangeTaskOwner(task, member)
                          }}
                          onEdit={() => openEditTaskModal(task)}
                          onDelete={() => {
                            setTaskMenuId(null)
                            onDeleteTask(task)
                          }}
                          onOpenSandbox={() => {
                            setTaskMenuId(null)
                            setSandboxTaskId(task.id)
                          }}
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
                  {tasks.map((task) => {
                    const sandboxMeta = getTaskSandboxMeta(task)
                    return (
                      <tr key={task.id}>
                        <td>
                          <span className="task-id">{task.id}</span>
                        </td>
                        <td className="table-title">
                          <div>{task.title}</div>
                          {task.description && (
                            <div className="table-task-desc">{task.description}</div>
                          )}
                        </td>
                        <td>{task.suggested_owner}</td>
                        <td>
                          <StatusBadge status={task.status} />
                        </td>
                        <td title={task.due_date}>{formatTaskDueDateDisplay(task.due_date, nowMs)}</td>
                        <td>
                          <div className="table-quick-actions">
                            <button
                              type="button"
                              className="quick-status-btn sandbox"
                              onClick={() => setSandboxTaskId(task.id)}
                            >
                              <Play size={10} />
                              {sandboxMeta.ctaLabel}
                            </button>
                            <button
                              type="button"
                              className={`quick-status-btn done ${task.status === "done" ? "is-active" : ""}`}
                              disabled={task.status === "done" || updatingTaskId === task.id}
                              onClick={() => onChangeTaskStatus(task, "done")}
                            >
                              Mark done
                            </button>
                            <button
                              type="button"
                              className={`quick-status-btn blocked ${task.status === "blocked" ? "is-active" : ""}`}
                              disabled={task.status === "blocked" || updatingTaskId === task.id}
                              onClick={() => onChangeTaskStatus(task, "blocked")}
                            >
                              Mark blocked
                            </button>
                            <button
                              type="button"
                              className="quick-status-btn"
                              disabled={updatingTaskId === task.id}
                              onClick={() => openEditTaskModal(task)}
                              aria-label={`Edit ${task.title}`}
                              title="Edit task"
                            >
                              <Pencil size={10} />
                              Edit
                            </button>
                            <button
                              type="button"
                              className="quick-status-btn danger"
                              disabled={updatingTaskId === task.id}
                              onClick={() => onDeleteTask(task)}
                              aria-label={`Delete ${task.title}`}
                              title="Delete task"
                            >
                              <Trash2 size={10} />
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
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
              Add a task manually, paste a project brief with <code>@cohort extract</code> in chat,
              or generate tasks with Gemini.
            </p>
            <div className="empty-board-actions">
              <button type="button" onClick={openCreateTaskModal}>
                <Plus size={14} /> Add task
              </button>
              <button type="button" onClick={onOpenExtractModal}>
                <Sparkles size={14} /> Extract from a brief
              </button>
            </div>
          </div>
        )}

        <div className="board-footer">
          <span>
            <span className="live-dot" /> Changes sync automatically
          </span>
          <button onClick={() => onToast("Board synced in real time")}>
            Live Firestore sync <ArrowDown size={13} />
          </button>
        </div>
      </section>

      {taskModalMode && (
        <TaskFormModal
          key={taskModalMode === "edit" ? `edit:${editingTask?.id || ""}` : "create"}
          mode={taskModalMode}
          editingTask={editingTask}
          roomCode={activeRoom.code}
          user={user}
          approvedMembers={approvedMembers}
          nowMs={nowMs}
          onClose={closeTaskModal}
          onToast={onToast}
        />
      )}

      {sandboxTask && user && (
        <TaskSandboxModal
          task={sandboxTask}
          roomCode={activeRoom.code}
          roomTitle={activeRoom.title}
          projectSummary={activeRoom.summary}
          user={user}
          updatingStatus={updatingTaskId === sandboxTask.id}
          onStatusChange={(status) => onChangeTaskStatus(sandboxTask, status)}
          onClose={() => setSandboxTaskId(null)}
          onToast={onToast}
        />
      )}
    </>
  )
}

function TaskFormModal({
  mode,
  editingTask,
  roomCode,
  user,
  approvedMembers,
  nowMs,
  onClose,
  onToast,
}: {
  mode: "create" | "edit"
  editingTask: Task | null
  roomCode: string
  user: User | null
  approvedMembers: Member[]
  nowMs: number
  onClose: () => void
  onToast: (msg: string, tone?: "success" | "error") => void
}) {
  const [taskTitle, setTaskTitle] = useState(() =>
    mode === "edit" && editingTask ? editingTask.title : ""
  )
  const [taskDescription, setTaskDescription] = useState(() =>
    mode === "edit" && editingTask ? editingTask.description || "" : ""
  )
  const [taskType, setTaskType] = useState<TaskType>(() =>
    mode === "edit" && editingTask
      ? editingTask.task_type || getTaskSandboxMeta(editingTask).type
      : "general"
  )
  const [taskWeight, setTaskWeight] = useState<TaskWeight>(() =>
    mode === "edit" && editingTask ? normalizeTaskWeight(editingTask.weight) ?? 1 : 1
  )
  const [taskOwnerUid, setTaskOwnerUid] = useState(() =>
    resolveInitialOwnerUid(mode, editingTask, approvedMembers, user?.uid)
  )
  const [taskDueDate, setTaskDueDate] = useState(() =>
    mode === "edit" && editingTask
      ? toDueDateInputValue(editingTask.due_date, nowMs)
      : getTodayDateInputValue()
  )
  const [savingTask, setSavingTask] = useState(false)
  const [taskModalError, setTaskModalError] = useState("")

  const handleClose = () => {
    if (savingTask) return
    onClose()
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!user || savingTask) return

    const cleanTitle = taskTitle.trim()
    const cleanDescription = taskDescription.trim()
    const cleanDueDate = taskDueDate.trim()

    if (!cleanTitle || cleanTitle.length > 200) {
      setTaskModalError("Title must be between 1 and 200 characters.")
      return
    }
    if (cleanDescription.length > 500) {
      setTaskModalError("Description must be 500 characters or fewer.")
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDueDate)) {
      setTaskModalError("Please select a valid due date.")
      return
    }

    const selectedMember = approvedMembers.find((m) => m.uid === taskOwnerUid)
    const ownerUid = selectedMember ? selectedMember.uid : ""
    const suggestedOwner = selectedMember
      ? `@${selectedMember.name.split(/\s+/)[0] || selectedMember.name}`.slice(0, 80)
      : mode === "edit" && editingTask && !editingTask.owner_uid && editingTask.suggested_owner
        ? editingTask.suggested_owner.slice(0, 80)
        : "@Team"

    setSavingTask(true)
    setTaskModalError("")
    try {
      if (mode === "create") {
        await createTaskFirestore(
          roomCode,
          {
            title: cleanTitle,
            description: cleanDescription,
            task_type: taskType,
            weight: taskWeight,
            owner_uid: ownerUid,
            suggested_owner: suggestedOwner,
            due_date: cleanDueDate,
          },
          user
        )
        onClose()
        onToast("Task added to board")
      } else if (mode === "edit" && editingTask) {
        await updateTaskFieldsFirestore(
          roomCode,
          editingTask,
          {
            title: cleanTitle,
            description: cleanDescription,
            task_type: taskType,
            weight: taskWeight,
            owner_uid: ownerUid,
            suggested_owner: suggestedOwner,
            due_date: cleanDueDate,
          },
          user
        )
        onClose()
        onToast("Task updated")
      }
    } catch (cause) {
      const friendly = getFriendlyErrorMessage(cause, "Could not save task. Please try again.")
      setTaskModalError(friendly)
      onToast(friendly, "error")
    } finally {
      setSavingTask(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !savingTask) handleClose()
      }}
    >
      <section
        className="extract-dialog task-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-modal-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") handleClose()
        }}
      >
        <button
          type="button"
          className="dialog-close"
          onClick={handleClose}
          disabled={savingTask}
          aria-label="Close task dialog"
        >
          <X size={18} />
        </button>
        <div className="dialog-icon">
          {mode === "edit" ? <Pencil size={18} /> : <Plus size={20} />}
        </div>
        <p className="section-kicker">
          {mode === "edit" && editingTask ? `EDIT TASK · ${editingTask.id.toUpperCase()}` : "NEW TASK"}
        </p>
        <h2 id="task-modal-title">
          {mode === "edit" ? "Edit task details" : "Add a task to the board"}
        </h2>
        <p className="dialog-description">
          {mode === "edit"
            ? "Update the task title, notes, type, owner, or due date."
            : "Create a structured task for your team and sync it in real time."}
        </p>
        <form onSubmit={(e) => void handleSubmit(e)} className="task-modal-form">
          <div className="task-modal-field">
            <div className="task-modal-label-row">
              <label htmlFor="manual-task-title">Title</label>
              <span>{taskTitle.trim().length}/200</span>
            </div>
            <input
              id="manual-task-title"
              type="text"
              autoFocus
              required
              minLength={1}
              maxLength={200}
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              placeholder="e.g. Build signup form validation"
              disabled={savingTask}
            />
          </div>

          <div className="task-modal-field">
            <div className="task-modal-label-row">
              <label htmlFor="manual-task-desc">Description</label>
              <span>{taskDescription.length}/500</span>
            </div>
            <textarea
              id="manual-task-desc"
              maxLength={500}
              rows={3}
              value={taskDescription}
              onChange={(event) => setTaskDescription(event.target.value)}
              placeholder="Optional context, acceptance criteria, or notes..."
              disabled={savingTask}
            />
          </div>

          <div className="task-modal-row">
            <div className="task-modal-field">
              <label htmlFor="manual-task-type">Task type</label>
              <select
                id="manual-task-type"
                value={taskType}
                onChange={(event) => setTaskType(event.target.value as TaskType)}
                disabled={savingTask}
              >
                <option value="frontend">Frontend</option>
                <option value="backend">Backend</option>
                <option value="design">Design</option>
                <option value="research">Research</option>
                <option value="general">General</option>
              </select>
            </div>

            <div className="task-modal-field">
              <label htmlFor="manual-task-owner">Owner</label>
              <select
                id="manual-task-owner"
                value={taskOwnerUid}
                onChange={(event) => setTaskOwnerUid(event.target.value)}
                disabled={savingTask}
              >
                <option value="">@Team (Unassigned)</option>
                {approvedMembers.map((member) => (
                  <option key={member.uid} value={member.uid}>
                    {member.name} (@{member.name.split(/\s+/)[0] || member.name})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="task-modal-row">
            <div className="task-modal-field">
              <label htmlFor="manual-task-due">Due date</label>
              <input
                id="manual-task-due"
                type="date"
                required
                value={taskDueDate}
                onChange={(event) => setTaskDueDate(event.target.value)}
                disabled={savingTask}
              />
            </div>

            <div className="task-modal-field">
              <label htmlFor="manual-task-weight">Weight (1–3)</label>
              <select
                id="manual-task-weight"
                value={taskWeight}
                onChange={(event) =>
                  setTaskWeight(normalizeTaskWeight(Number(event.target.value)) ?? 1)
                }
                disabled={savingTask}
              >
                <option value={1}>1 · Small (1×)</option>
                <option value={2}>2 · Standard (2×)</option>
                <option value={3}>3 · Large (3×)</option>
              </select>
            </div>
          </div>

          {taskModalError && (
            <p className="form-error modal-error" role="alert">
              {taskModalError}
            </p>
          )}

          <div className="dialog-footer task-modal-footer">
            <button
              type="button"
              className="secondary-btn"
              onClick={handleClose}
              disabled={savingTask}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={savingTask || !taskTitle.trim() || !taskDueDate}
            >
              {savingTask ? (
                <>
                  <LoaderCircle className="spin" size={15} /> Saving…
                </>
              ) : mode === "edit" ? (
                <>
                  Save changes <Check size={15} />
                </>
              ) : (
                <>
                  Add task <Plus size={15} />
                </>
              )}
            </button>
          </div>
        </form>
      </section>
    </div>
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
  nowMs,
  menuOpen,
  updating,
  onToggleMenu,
  onStatusChange,
  onReassign,
  onEdit,
  onDelete,
  onOpenSandbox,
}: {
  task: Task
  members: Member[]
  nowMs: number
  menuOpen: boolean
  updating: boolean
  onToggleMenu: () => void
  onStatusChange: (status: TaskStatus) => void
  onReassign: (member: Member) => void
  onEdit: () => void
  onDelete: () => void
  onOpenSandbox: () => void
}) {
  const sandboxMeta = getTaskSandboxMeta(task)
  const formattedDue = formatTaskDueDateDisplay(task.due_date, nowMs)

  return (
    <article className="task-card">
      <div className="task-card-top">
        <span className="task-card-meta-inline">
          <span className="task-id">{task.id}</span>
          <span aria-hidden="true">·</span>
          <span className={`task-type-inline is-${sandboxMeta.type}`}>
            {sandboxMeta.typeLabel}
          </span>
          {task.weight && task.weight > 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="task-weight-inline" title={`Effort weight ${task.weight}x`}>
                {task.weight}×
              </span>
            </>
          )}
        </span>
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
      {task.description && <p className="task-card-desc">{task.description}</p>}
      <div className="task-card-bottom">
        <span className="task-owner">
          <span className="owner-avatar">
            {initials(task.suggested_owner.replace(/^@/, ""))}
          </span>
          {task.suggested_owner}
        </span>
        <span className="due-date" title={task.due_date}>
          <ArrowUpRight size={12} />
          {formattedDue}
        </span>
      </div>
      <button
        type="button"
        className={`task-sandbox-trigger is-${sandboxMeta.type}`}
        onClick={onOpenSandbox}
      >
        <Play size={11} />
        <span>{sandboxMeta.ctaLabel}</span>
      </button>
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
          <button type="button" onClick={onOpenSandbox}>
            <Play size={13} />
            {sandboxMeta.ctaLabel}
          </button>
          <button type="button" onClick={onEdit} disabled={updating}>
            <Pencil size={13} />
            Edit
          </button>
          <button
            type="button"
            className="task-action-danger"
            onClick={onDelete}
            disabled={updating}
          >
            <Trash2 size={13} />
            Delete
          </button>
          <div className="task-action-divider" />
          <button
            type="button"
            onClick={() => onStatusChange("todo")}
            disabled={task.status === "todo" || updating}
          >
            To do
          </button>
          <button
            type="button"
            onClick={() => onStatusChange("in_progress")}
            disabled={task.status === "in_progress" || updating}
          >
            In progress
          </button>
          <button
            type="button"
            onClick={() => onStatusChange("done")}
            disabled={task.status === "done" || updating}
          >
            <Check size={13} />
            Mark done
          </button>
          <button
            type="button"
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
                  type="button"
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

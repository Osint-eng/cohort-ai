import type { TaskStatus } from "@/lib/api"

export const commands = [
  "@cohort help",
  "@cohort extract",
  "@cohort check-in",
  "@cohort mark t1 complete",
  "@cohort mark t2 blocked because ",
  "@cohort list",
]

export const statusColumns: { id: TaskStatus; label: string; dot: string }[] = [
  { id: "todo", label: "To do", dot: "bg-stone-400" },
  { id: "in_progress", label: "In progress", dot: "bg-orange-500" },
  { id: "blocked", label: "Blocked", dot: "bg-rose-500" },
  { id: "done", label: "Done", dot: "bg-emerald-500" },
]

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?"

export const colors = [
  "bg-orange-100 text-orange-800",
  "bg-violet-100 text-violet-800",
  "bg-sky-100 text-sky-800",
  "bg-emerald-100 text-emerald-800",
]

export const colorIndexForId = (id: string) => {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % colors.length
}

export const relativeTime = (ts: string) => {
  const parsed = new Date(ts).getTime()
  if (Number.isNaN(parsed)) return "now"
  const mins = Math.max(0, Math.floor((Date.now() - parsed) / 60000))
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

export const themeStorageKey = "cohort-theme"

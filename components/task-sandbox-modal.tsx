"use client"

import { useEffect, useMemo, useState } from "react"
import type { User } from "firebase/auth"
import {
  Check,
  Code2,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  Play,
  RotateCcw,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react"
import {
  generateTaskSandboxWithCohort,
  type Task,
  type TaskStatus,
} from "@/lib/api"
import {
  buildCodeSandboxParameters,
  buildStarterFilesForTask,
  compilePreviewSrcDoc,
  getTaskSandboxMeta,
  type SandboxFiles,
  type SandboxTemplateMode,
} from "@/lib/task-sandbox"

function renderBriefPreviewLines(markdown: string) {
  return markdown.split("\n").map((line, idx) => {
    if (line.startsWith("# ")) {
      return (
        <h4 key={idx} className="sb-md-h1">
          {line.slice(2)}
        </h4>
      )
    }
    if (line.startsWith("## ")) {
      return (
        <h5 key={idx} className="sb-md-h2">
          {line.slice(3)}
        </h5>
      )
    }
    if (line.startsWith("- ")) {
      return (
        <div key={idx} className="sb-md-li">
          <span aria-hidden="true">•</span>
          <span>{line.slice(2).replace(/\*\*/g, "")}</span>
        </div>
      )
    }
    if (/^\d+\.\s/.test(line)) {
      return (
        <div key={idx} className="sb-md-li">
          <span>{line.replace(/\*\*/g, "")}</span>
        </div>
      )
    }
    if (line.startsWith("|")) {
      return (
        <div key={idx} className="sb-md-table-row">
          {line}
        </div>
      )
    }
    if (!line.trim()) {
      return <div key={idx} className="sb-md-spacer" />
    }
    return (
      <p key={idx} className="sb-md-p">
        {line.replace(/\*\*/g, "")}
      </p>
    )
  })
}

export default function TaskSandboxModal({
  task,
  roomCode,
  roomTitle,
  projectSummary,
  user,
  updatingStatus,
  onStatusChange,
  onClose,
  onToast,
}: {
  task: Task
  roomCode: string
  roomTitle: string
  projectSummary: string
  user: User
  updatingStatus: boolean
  onStatusChange: (status: TaskStatus) => void
  onClose: () => void
  onToast: (msg: string, tone?: "success" | "error") => void
}) {
  const meta = useMemo(() => getTaskSandboxMeta(task), [task])
  const storageKey = `cohort-sandbox:${roomCode}:${task.id}`

  const [templateMode, setTemplateMode] = useState<SandboxTemplateMode>(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = sessionStorage.getItem(storageKey)
        if (raw) {
          const parsed = JSON.parse(raw) as { templateMode?: SandboxTemplateMode }
          if (parsed.templateMode) return parsed.templateMode
        }
      } catch {
        // Ignore invalid draft cache
      }
    }
    return meta.defaultTemplate
  })

  const [files, setFiles] = useState<SandboxFiles>(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = sessionStorage.getItem(storageKey)
        if (raw) {
          const parsed = JSON.parse(raw) as {
            files?: SandboxFiles
            templateMode?: SandboxTemplateMode
          }
          if (parsed.files && Object.keys(parsed.files).length > 0) {
            return parsed.files
          }
        }
      } catch {
        // Fallback to starter builder
      }
    }
    return buildStarterFilesForTask(
      task,
      roomTitle,
      projectSummary,
      meta.defaultTemplate
    ).files
  })

  const fileNames = useMemo(() => Object.keys(files), [files])
  const [activeFile, setActiveFile] = useState<string>(() => fileNames[0] || "")
  const [debouncedFiles, setDebouncedFiles] = useState<SandboxFiles>(files)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [generatingAi, setGeneratingAi] = useState(false)

  useEffect(() => {
    if (!fileNames.includes(activeFile)) {
      setActiveFile(fileNames[0] || "")
    }
  }, [fileNames, activeFile])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedFiles(files)
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ templateMode, files })
        )
      } catch {
        // Ignore storage quota errors
      }
    }, 180)
    return () => window.clearTimeout(timer)
  }, [files, templateMode, storageKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !generatingAi) {
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, generatingAi])

  const isPreviewable =
    templateMode === "react" ||
    templateMode === "vanilla" ||
    templateMode === "design"

  const previewResult = useMemo(() => {
    if (!isPreviewable) return { html: "", compileError: null }
    return compilePreviewSrcDoc(debouncedFiles, templateMode)
  }, [debouncedFiles, templateMode, isPreviewable])

  const codeSandboxParams = useMemo(() => {
    if (!meta.supportsCodeSandbox) return ""
    return buildCodeSandboxParameters(files)
  }, [files, meta.supportsCodeSandbox])

  const handleSwitchTemplate = (nextMode: SandboxTemplateMode) => {
    if (nextMode === templateMode) return
    const built = buildStarterFilesForTask(task, roomTitle, projectSummary, nextMode)
    setTemplateMode(built.templateMode)
    setFiles(built.files)
    setActiveFile(Object.keys(built.files)[0] || "")
    setPreviewNonce((n) => n + 1)
  }

  const handleResetStarter = () => {
    const built = buildStarterFilesForTask(task, roomTitle, projectSummary, templateMode)
    setFiles(built.files)
    setActiveFile(Object.keys(built.files)[0] || "")
    setPreviewNonce((n) => n + 1)
    onToast("Starter template reset")
  }

  const handleGenerateWithCohort = async () => {
    if (generatingAi) return
    setGeneratingAi(true)
    try {
      const generated = await generateTaskSandboxWithCohort(
        roomCode,
        user,
        task.id,
        templateMode
      )
      setTemplateMode(generated.templateMode)
      setFiles(generated.files)
      setActiveFile(Object.keys(generated.files)[0] || "")
      setPreviewNonce((n) => n + 1)
      onToast("@cohort generated a custom starter for " + task.id)
    } catch (cause) {
      const msg =
        cause instanceof Error
          ? cause.message
          : "Could not generate starter right now."
      onToast(msg, "error")
    } finally {
      setGeneratingAi(false)
    }
  }

  const handleCopyActiveFile = async () => {
    const content = files[activeFile] || ""
    await navigator.clipboard?.writeText(content).catch(() => {})
    onToast(`Copied ${activeFile}`)
  }

  const handleDownloadBrief = () => {
    const content =
      files["RESEARCH_BRIEF.md"] ||
      files["TASK_BRIEF.md"] ||
      Object.values(files)[0] ||
      ""
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${task.id}-${meta.type}-starter.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    onToast("Starter brief downloaded")
  }

  const parsedSchema = useMemo(() => {
    if (templateMode !== "backend") return null
    try {
      return JSON.parse(files["schema.json"] || "{}") as {
        endpoint?: string
        method?: string
        requestExample?: Record<string, unknown>
        responseExample?: Record<string, unknown>
      }
    } catch {
      return null
    }
  }, [templateMode, files])

  return (
    <div
      className="modal-backdrop sandbox-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !generatingAi) onClose()
      }}
    >
      <section
        className="sandbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sandbox-task-title"
      >
        <header className="sandbox-header-bar">
          <div className="sandbox-header-copy">
            <div className="sandbox-meta-row">
              <span className="task-id">{task.id}</span>
              <span aria-hidden="true">·</span>
              <span className={`task-type-label is-${meta.type}`}>{meta.typeLabel}</span>
              <span aria-hidden="true">·</span>
              <span>{task.suggested_owner}</span>
              <span aria-hidden="true">·</span>
              <span>Due {task.due_date}</span>
            </div>
            <h2 id="sandbox-task-title">{task.title}</h2>
            {task.description && (
              <p className="sandbox-task-desc">{task.description}</p>
            )}
          </div>

          <div className="sandbox-header-actions">
            {task.status !== "in_progress" && task.status !== "done" && (
              <button
                type="button"
                className="sandbox-board-btn"
                disabled={updatingStatus}
                onClick={() => onStatusChange("in_progress")}
              >
                <Play size={13} />
                Start task
              </button>
            )}
            {task.status !== "done" ? (
              <button
                type="button"
                className="sandbox-board-btn is-done"
                disabled={updatingStatus}
                onClick={() => onStatusChange("done")}
              >
                <Check size={13} />
                Mark done
              </button>
            ) : (
              <span className="sandbox-done-note">
                <Check size={13} /> Done on board
              </span>
            )}
            <button
              type="button"
              className="sandbox-close-btn"
              onClick={onClose}
              disabled={generatingAi}
              aria-label="Close sandbox"
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="sandbox-toolbar">
          <div className="sandbox-toolbar-left">
            {meta.type === "frontend" && (
              <div className="sandbox-template-switch" role="group" aria-label="Frontend template">
                <button
                  type="button"
                  className={templateMode === "react" ? "active" : ""}
                  onClick={() => handleSwitchTemplate("react")}
                >
                  React JSX
                </button>
                <button
                  type="button"
                  className={templateMode === "vanilla" ? "active" : ""}
                  onClick={() => handleSwitchTemplate("vanilla")}
                >
                  HTML / CSS / JS
                </button>
              </div>
            )}

            <button
              type="button"
              className="sandbox-ai-btn"
              onClick={() => void handleGenerateWithCohort()}
              disabled={generatingAi}
            >
              {generatingAi ? (
                <>
                  <LoaderCircle className="spin" size={13} />
                  Building starter…
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  Generate with @cohort
                </>
              )}
            </button>
          </div>

          <div className="sandbox-toolbar-right">
            <button
              type="button"
              className="sandbox-util-btn"
              onClick={handleCopyActiveFile}
            >
              <Copy size={13} />
              Copy file
            </button>
            <button
              type="button"
              className="sandbox-util-btn"
              onClick={handleResetStarter}
            >
              <RotateCcw size={13} />
              Reset
            </button>
            <button
              type="button"
              className="sandbox-util-btn"
              onClick={handleDownloadBrief}
            >
              <Download size={13} />
              Brief
            </button>
            {meta.supportsCodeSandbox && codeSandboxParams && (
              <form
                action="https://codesandbox.io/api/v1/sandboxes/define"
                method="POST"
                target="_blank"
                className="codesandbox-form"
              >
                <input type="hidden" name="parameters" value={codeSandboxParams} />
                <button type="submit" className="sandbox-csb-btn">
                  <ExternalLink size={13} />
                  Open in CodeSandbox
                </button>
              </form>
            )}
          </div>
        </div>

        <div className="sandbox-split">
          <div className="sandbox-editor-pane">
            <div className="sandbox-file-tabs" role="tablist" aria-label="Starter files">
              {fileNames.map((fileName) => (
                <button
                  key={fileName}
                  type="button"
                  role="tab"
                  aria-selected={activeFile === fileName}
                  className={activeFile === fileName ? "active" : ""}
                  onClick={() => setActiveFile(fileName)}
                >
                  <Code2 size={12} />
                  <span>{fileName}</span>
                </button>
              ))}
            </div>
            <textarea
              className="sandbox-code-editor"
              value={files[activeFile] || ""}
              onChange={(event) => {
                const nextValue = event.target.value
                setFiles((prev) => ({ ...prev, [activeFile]: nextValue }))
              }}
              spellCheck={false}
              aria-label={`Code editor for ${activeFile}`}
            />
            {previewResult.compileError && (
              <div className="sandbox-compile-error" role="alert">
                {previewResult.compileError}
              </div>
            )}
          </div>

          <div className="sandbox-preview-pane">
            <div className="sandbox-preview-head">
              <span>
                {isPreviewable
                  ? "Live Preview"
                  : templateMode === "backend"
                    ? "API Contract & Test Surface"
                    : "Brief & Deliverable Preview"}
              </span>
              {isPreviewable && (
                <button
                  type="button"
                  className="sandbox-refresh-btn"
                  onClick={() => setPreviewNonce((n) => n + 1)}
                >
                  <RotateCw size={12} />
                  Reload
                </button>
              )}
            </div>

            {isPreviewable ? (
              <iframe
                key={`${templateMode}-${previewNonce}`}
                title={`Live preview for ${task.title}`}
                className="sandbox-preview-iframe"
                sandbox="allow-scripts"
                srcDoc={previewResult.html}
              />
            ) : templateMode === "backend" ? (
              <div className="sandbox-non-ui-preview">
                <div className="sb-api-card">
                  <div className="sb-api-line">
                    <span className="sb-method">{parsedSchema?.method || "POST"}</span>
                    <code>{parsedSchema?.endpoint || `/api/${task.id}`}</code>
                  </div>
                  <p className="sb-api-note">
                    Use this handler scaffold in your Next.js API routes, or click{" "}
                    <strong>Open in CodeSandbox</strong> above to run and test it in a Node sandbox.
                  </p>
                  <pre className="sb-curl-block">
                    {`curl -X ${parsedSchema?.method || "POST"} http://localhost:3000${parsedSchema?.endpoint || `/api/${task.id}`} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(parsedSchema?.requestExample || { input: "test" })}'`}
                  </pre>
                </div>
                <div className="sb-brief-card">
                  {renderBriefPreviewLines(files["TASK_BRIEF.md"] || "")}
                </div>
              </div>
            ) : (
              <div className="sandbox-non-ui-preview">
                <div className="sb-brief-card">
                  {renderBriefPreviewLines(
                    files[activeFile]?.endsWith(".md")
                      ? files[activeFile]
                      : files["RESEARCH_BRIEF.md"] || files["TASK_BRIEF.md"] || ""
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="sandbox-footer">
          <span>
            The Kanban board remains your team’s source of truth — edits here stay local to this preview surface until you update status or paste results in chat.
          </span>
        </footer>
      </section>
    </div>
  )
}

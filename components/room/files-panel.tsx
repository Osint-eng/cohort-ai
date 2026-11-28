"use client"

import { useMemo, useState, type ChangeEvent, type FormEvent } from "react"
import type { User } from "firebase/auth"
import {
  Check,
  Download,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FolderGit2,
  LayoutGrid,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react"
import {
  createRoomFileFirestore,
  deleteRoomFileFirestore,
  getFriendlyErrorMessage,
  importGitRepoFiles,
  pushRoomFilesToGit,
  updateRoomFileFirestore,
  type Member,
  type RoomFile,
  type RoomMeta,
} from "@/lib/api"
import {
  ALLOWED_TEXT_EXTENSIONS,
  getUtf8ByteSize,
  MAX_FILE_SIZE_BYTES,
  MAX_ROOM_FILES,
  validateRoomFileInput,
} from "@/lib/room-files"
import "@/app/styles/files.css"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export default function FilesPanel({
  activeRoom,
  user,
  isOwner,
  activeTab,
  files,
  members,
  onSwitchToBoard,
  onToast,
}: {
  activeRoom: RoomMeta
  user: User | null
  isOwner: boolean
  activeTab: string
  files: RoomFile[]
  members: Member[]
  onSwitchToBoard: () => void
  onToast: (msg: string, tone?: "success" | "error") => void
}) {
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [draftContentByFileId, setDraftContentByFileId] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState("")
  const [savingFileId, setSavingFileId] = useState<string | null>(null)
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const [newFileModalOpen, setNewFileModalOpen] = useState(false)
  const [newFilePath, setNewFilePath] = useState("")
  const [newFileContent, setNewFileContent] = useState("")
  const [newFileError, setNewFileError] = useState("")
  const [creatingFile, setCreatingFile] = useState(false)

  const [gitImportOpen, setGitImportOpen] = useState(false)
  const [importRepoUrl, setImportRepoUrl] = useState("")
  const [importBranch, setImportBranch] = useState("")
  const [importingGit, setImportingGit] = useState(false)
  const [importError, setImportError] = useState("")
  const [importSummary, setImportSummary] = useState<{
    importedCount: number
    skippedCount: number
    repo: string
    branch: string
  } | null>(null)

  const [gitPushOpen, setGitPushOpen] = useState(false)
  const [pushRepoUrl, setPushRepoUrl] = useState("")
  const [pushBranch, setPushBranch] = useState("main")
  const [pushPat, setPushPat] = useState("")
  const [pushingGit, setPushingGit] = useState(false)
  const [pushError, setPushError] = useState("")
  const [pushSuccess, setPushSuccess] = useState<{
    commitUrl: string
    filesCount: number
    repo: string
    branch: string
  } | null>(null)

  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, searchQuery])

  const selectedFile = useMemo(() => {
    if (files.length === 0) return null
    if (selectedFileId) {
      const exact = files.find((f) => f.id === selectedFileId)
      if (exact) return exact
    }
    return filteredFiles[0] || files[0]
  }, [files, filteredFiles, selectedFileId])

  const editorValue = selectedFile
    ? selectedFile.id in draftContentByFileId
      ? draftContentByFileId[selectedFile.id]
      : selectedFile.content
    : ""

  const isDirty = Boolean(
    selectedFile &&
      selectedFile.id in draftContentByFileId &&
      draftContentByFileId[selectedFile.id] !== selectedFile.content
  )

  const editorByteSize = selectedFile ? getUtf8ByteSize(editorValue) : 0
  const canDeleteSelected = Boolean(
    selectedFile && user && (isOwner || selectedFile.createdBy === user.uid)
  )

  const memberNameByUid = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of members) map.set(m.uid, m.name)
    return map
  }, [members])

  const handleSaveSelected = async () => {
    if (!selectedFile || !user || savingFileId) return
    setSavingFileId(selectedFile.id)
    try {
      await updateRoomFileFirestore(
        activeRoom.code,
        selectedFile,
        { content: editorValue },
        user,
        files
      )
      setDraftContentByFileId((prev) => {
        const next = { ...prev }
        delete next[selectedFile.id]
        return next
      })
      onToast(`Saved ${selectedFile.path}`)
    } catch (cause) {
      onToast(getFriendlyErrorMessage(cause, "Could not save file."), "error")
    } finally {
      setSavingFileId(null)
    }
  }

  const handleRevertSelected = () => {
    if (!selectedFile) return
    setDraftContentByFileId((prev) => {
      const next = { ...prev }
      delete next[selectedFile.id]
      return next
    })
  }

  const handleDeleteSelected = async (file: RoomFile) => {
    if (!user || deletingFileId) return
    setDeletingFileId(file.id)
    try {
      await deleteRoomFileFirestore(activeRoom.code, file, user)
      setConfirmDeleteId(null)
      setDraftContentByFileId((prev) => {
        const next = { ...prev }
        delete next[file.id]
        return next
      })
      if (selectedFileId === file.id) {
        setSelectedFileId(null)
      }
      onToast(`Deleted ${file.path}`)
    } catch (cause) {
      onToast(getFriendlyErrorMessage(cause, "Could not delete file."), "error")
    } finally {
      setDeletingFileId(null)
    }
  }

  const handleLocalUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setNewFileError("")
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setNewFileError(
        `File exceeds the 200KB text limit (${Math.ceil(file.size / 1024)}KB).`
      )
      return
    }
    try {
      const text = await file.text()
      const check = validateRoomFileInput(file.name, text)
      if (!check.ok) {
        setNewFileError(check.error)
        return
      }
      setNewFilePath(check.path)
      setNewFileContent(check.content)
    } catch {
      setNewFileError("Could not read file as UTF-8 text.")
    }
  }

  const handleCreateFile = async (e: FormEvent) => {
    e.preventDefault()
    if (!user || creatingFile) return
    setNewFileError("")
    setCreatingFile(true)
    try {
      const createdId = await createRoomFileFirestore(
        activeRoom.code,
        { path: newFilePath, content: newFileContent },
        user,
        files
      )
      setSelectedFileId(createdId)
      setNewFileModalOpen(false)
      setNewFilePath("")
      setNewFileContent("")
      onToast("Project file added")
    } catch (cause) {
      setNewFileError(getFriendlyErrorMessage(cause, "Could not create file."))
    } finally {
      setCreatingFile(false)
    }
  }

  const handleImportSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!user || importingGit) return
    setImportError("")
    setImportingGit(true)
    try {
      const result = await importGitRepoFiles(activeRoom.code, user, {
        repoUrl: importRepoUrl,
        branch: importBranch,
      })
      setImportSummary({
        importedCount: result.importedCount,
        skippedCount: result.skippedCount,
        repo: result.repo,
        branch: result.branch,
      })
      if (!pushRepoUrl) setPushRepoUrl(importRepoUrl.trim())
      if (result.branch) setPushBranch(result.branch)
      setGitImportOpen(false)
      onToast(`Imported ${result.importedCount} files (skipped ${result.skippedCount})`)
    } catch (cause) {
      setImportError(getFriendlyErrorMessage(cause, "Git import failed."))
    } finally {
      setImportingGit(false)
    }
  }

  const handlePushSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!user || !isOwner || pushingGit) return
    setPushError("")
    setPushingGit(true)
    try {
      const result = await pushRoomFilesToGit(activeRoom.code, user, {
        repoUrl: pushRepoUrl,
        branch: pushBranch,
        pat: pushPat,
      })
      // Immediately clear PAT from React state after request finishes
      setPushPat("")
      setPushSuccess({
        commitUrl: result.commitUrl,
        filesCount: result.filesCount,
        repo: result.repo,
        branch: result.branch,
      })
      setGitPushOpen(false)
      onToast(`Pushed ${result.filesCount} files to ${result.repo}`)
    } catch (cause) {
      setPushError(getFriendlyErrorMessage(cause, "Git push failed."))
    } finally {
      setPushingGit(false)
    }
  }

  return (
    <>
      <section
        className={`panel files-panel ${activeTab !== "Files" ? "mobile-hidden" : ""}`}
        aria-label="Project files"
      >
        <div className="panel-header files-header">
          <div className="files-header-left">
            <div className="center-panel-tabs" role="tablist" aria-label="Center workspace">
              <button type="button" role="tab" aria-selected={false} onClick={onSwitchToBoard}>
                <LayoutGrid size={13} />
                Board
              </button>
              <button type="button" role="tab" aria-selected={true} className="active">
                <FileCode2 size={13} />
                Files <span className="task-count">{files.length}/{MAX_ROOM_FILES}</span>
              </button>
            </div>
          </div>

          <div className="files-header-actions">
            <button
              type="button"
              className="files-btn"
              onClick={() => {
                setImportError("")
                setGitImportOpen(true)
              }}
            >
              <Download size={13} />
              Import from Git
            </button>
            {isOwner && (
              <button
                type="button"
                className="files-btn"
                disabled={files.length === 0}
                title={
                  files.length === 0
                    ? "Add or import files before pushing to Git"
                    : "Push room files to GitHub"
                }
                onClick={() => {
                  setPushError("")
                  setGitPushOpen(true)
                }}
              >
                <UploadCloud size={13} />
                Push to Git
              </button>
            )}
            <button
              type="button"
              className="files-btn primary"
              disabled={files.length >= MAX_ROOM_FILES}
              onClick={() => {
                setNewFileError("")
                setNewFileModalOpen(true)
              }}
            >
              <FilePlus2 size={13} />
              New file
            </button>
          </div>
        </div>

        {importSummary && (
          <div className="files-banner" role="status">
            <div className="files-banner-copy">
              <Check size={14} />
              <span>
                Imported <strong>{importSummary.importedCount}</strong> files from{" "}
                <code>
                  {importSummary.repo}@{importSummary.branch}
                </code>
                , skipped <strong>{importSummary.skippedCount}</strong>.
              </span>
            </div>
            <button
              type="button"
              aria-label="Dismiss import summary"
              onClick={() => setImportSummary(null)}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {pushSuccess && (
          <div className="files-banner" role="status">
            <div className="files-banner-copy">
              <Check size={14} />
              <span>
                Pushed <strong>{pushSuccess.filesCount}</strong> files to{" "}
                <code>
                  {pushSuccess.repo}@{pushSuccess.branch}
                </code>
                .
              </span>
              <a href={pushSuccess.commitUrl} target="_blank" rel="noopener noreferrer">
                View commit <ExternalLink size={12} className="inline" />
              </a>
            </div>
            <button
              type="button"
              aria-label="Dismiss push summary"
              onClick={() => setPushSuccess(null)}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {files.length === 0 ? (
          <div className="empty-board">
            <div>
              <FolderGit2 size={20} />
            </div>
            <strong>No project files yet</strong>
            <p>
              Create a text file, upload code or docs, or import files directly from a public
              GitHub repository (up to {MAX_ROOM_FILES} files, 200KB each).
            </p>
            <div className="empty-board-actions">
              <button
                type="button"
                className="add-task-button"
                onClick={() => {
                  setNewFileError("")
                  setNewFileModalOpen(true)
                }}
              >
                <FilePlus2 size={14} /> New file
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportError("")
                  setGitImportOpen(true)
                }}
              >
                <Download size={14} /> Import from Git
              </button>
            </div>
          </div>
        ) : (
          <div className="files-workspace">
            <aside className="files-sidebar" aria-label="Room file list">
              <div className="files-search-wrap">
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter files…"
                  aria-label="Filter project files"
                />
              </div>
              <div className="files-list">
                {filteredFiles.length === 0 ? (
                  <p className="files-modal-hint p-2">No files match "{searchQuery}".</p>
                ) : (
                  filteredFiles.map((file) => {
                    const hasDraft =
                      file.id in draftContentByFileId &&
                      draftContentByFileId[file.id] !== file.content
                    return (
                      <button
                        key={file.id}
                        type="button"
                        className={`files-list-item ${
                          selectedFile?.id === file.id ? "selected" : ""
                        }`}
                        onClick={() => {
                          setSelectedFileId(file.id)
                          setConfirmDeleteId(null)
                        }}
                      >
                        <span className="files-list-path">
                          <FileCode2 size={13} className="shrink-0" />
                          <span>
                            {file.path}
                            {hasDraft ? " •" : ""}
                          </span>
                        </span>
                        <span className="files-list-meta">{formatBytes(file.size)}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </aside>

            {selectedFile && (
              <div className="files-editor-pane">
                <div className="files-editor-toolbar">
                  <div className="files-editor-meta">
                    <strong>{selectedFile.path}</strong>
                    <span>
                      {selectedFile.mimeType} · {formatBytes(editorByteSize)} / 200 KB · Updated by{" "}
                      {memberNameByUid.get(selectedFile.updatedBy) || "Member"}
                      {isDirty ? " · Unsaved changes" : ""}
                    </span>
                  </div>
                  <div className="files-editor-actions">
                    {isDirty && (
                      <button
                        type="button"
                        className="files-btn"
                        disabled={savingFileId === selectedFile.id}
                        onClick={handleRevertSelected}
                      >
                        <RotateCcw size={12} /> Revert
                      </button>
                    )}
                    <button
                      type="button"
                      className="files-btn primary"
                      disabled={
                        !isDirty ||
                        savingFileId === selectedFile.id ||
                        editorByteSize > MAX_FILE_SIZE_BYTES
                      }
                      onClick={() => void handleSaveSelected()}
                    >
                      {savingFileId === selectedFile.id ? (
                        <>
                          <LoaderCircle className="spin" size={12} /> Saving…
                        </>
                      ) : (
                        <>
                          <Save size={12} /> Save
                        </>
                      )}
                    </button>
                    {canDeleteSelected &&
                      (confirmDeleteId === selectedFile.id ? (
                        <>
                          <button
                            type="button"
                            className="files-btn danger"
                            disabled={deletingFileId === selectedFile.id}
                            onClick={() => void handleDeleteSelected(selectedFile)}
                          >
                            {deletingFileId === selectedFile.id ? "Deleting…" : "Confirm delete"}
                          </button>
                          <button
                            type="button"
                            className="files-btn"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="files-btn danger"
                          aria-label={`Delete ${selectedFile.path}`}
                          onClick={() => setConfirmDeleteId(selectedFile.id)}
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      ))}
                  </div>
                </div>
                <textarea
                  className="files-code-textarea"
                  value={editorValue}
                  spellCheck={false}
                  aria-label={`Edit ${selectedFile.path}`}
                  onChange={(e) =>
                    setDraftContentByFileId((prev) => ({
                      ...prev,
                      [selectedFile.id]: e.target.value,
                    }))
                  }
                />
              </div>
            )}
          </div>
        )}
      </section>

      {newFileModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-file-title"
          onClick={() => !creatingFile && setNewFileModalOpen(false)}
        >
          <div className="modal-dialog task-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">PROJECT FILES</p>
                <h2 id="new-file-title">Add text file</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close new file modal"
                onClick={() => !creatingFile && setNewFileModalOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={(e) => void handleCreateFile(e)} className="task-modal-form">
              <div className="files-upload-row">
                <label className="files-upload-label">
                  <Upload size={13} />
                  <span>Load from computer</span>
                  <input
                    type="file"
                    accept={ALLOWED_TEXT_EXTENSIONS.join(",")}
                    onChange={(e) => void handleLocalUpload(e)}
                  />
                </label>
                <span className="files-modal-hint">
                  Max 200KB · {ALLOWED_TEXT_EXTENSIONS.join(", ")}
                </span>
              </div>

              <div className="task-modal-field">
                <label htmlFor="new-file-path">Relative path</label>
                <input
                  id="new-file-path"
                  type="text"
                  value={newFilePath}
                  onChange={(e) => setNewFilePath(e.target.value)}
                  placeholder="e.g. README.md or src/index.ts"
                  required
                />
              </div>

              <div className="task-modal-field">
                <div className="task-modal-label-row">
                  <label htmlFor="new-file-content">Content</label>
                  <span>{formatBytes(getUtf8ByteSize(newFileContent))} / 200 KB</span>
                </div>
                <textarea
                  id="new-file-content"
                  rows={8}
                  value={newFileContent}
                  onChange={(e) => setNewFileContent(e.target.value)}
                  placeholder="Paste or type text content…"
                />
              </div>

              {newFileError && <div className="files-modal-error">{newFileError}</div>}

              <div className="modal-footer task-modal-footer">
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={creatingFile}
                  onClick={() => setNewFileModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={creatingFile}>
                  {creatingFile ? (
                    <>
                      <LoaderCircle className="spin" size={14} /> Adding…
                    </>
                  ) : (
                    <>
                      <FilePlus2 size={14} /> Add file
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {gitImportOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-import-title"
          onClick={() => !importingGit && setGitImportOpen(false)}
        >
          <div className="modal-dialog task-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">GITHUB IMPORT</p>
                <h2 id="git-import-title">Import from Git</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close import modal"
                onClick={() => !importingGit && setGitImportOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={(e) => void handleImportSubmit(e)} className="task-modal-form">
              <p className="files-modal-hint">
                Imports supported text files (<code>{ALLOWED_TEXT_EXTENSIONS.join(", ")}</code>, up
                to 200KB each, capped at {MAX_ROOM_FILES} total files in this room) from a public
                HTTPS GitHub repository. Binaries and <code>node_modules</code> / <code>.git</code>{" "}
                are skipped.
              </p>

              <div className="task-modal-field">
                <label htmlFor="git-import-url">Public GitHub HTTPS URL</label>
                <input
                  id="git-import-url"
                  type="url"
                  value={importRepoUrl}
                  onChange={(e) => setImportRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repository"
                  required
                />
              </div>

              <div className="task-modal-field">
                <label htmlFor="git-import-branch">Branch (optional)</label>
                <input
                  id="git-import-branch"
                  type="text"
                  value={importBranch}
                  onChange={(e) => setImportBranch(e.target.value)}
                  placeholder="main (or repository default)"
                />
              </div>

              {importError && <div className="files-modal-error">{importError}</div>}

              <div className="modal-footer task-modal-footer">
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={importingGit}
                  onClick={() => setGitImportOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={importingGit}>
                  {importingGit ? (
                    <>
                      <LoaderCircle className="spin" size={14} /> Importing tree…
                    </>
                  ) : (
                    <>
                      <Download size={14} /> Import files
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {gitPushOpen && isOwner && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-push-title"
          onClick={() => {
            if (!pushingGit) {
              setPushPat("")
              setGitPushOpen(false)
            }
          }}
        >
          <div className="modal-dialog task-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">OWNER ONLY</p>
                <h2 id="git-push-title">Push to Git</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close push modal"
                onClick={() => {
                  if (!pushingGit) {
                    setPushPat("")
                    setGitPushOpen(false)
                  }
                }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={(e) => void handlePushSubmit(e)} className="task-modal-form">
              <div className="files-banner m-0">
                <div className="files-banner-copy">
                  <ShieldAlert size={14} />
                  <span>
                    Your Personal Access Token is used in-memory for this commit only and is never
                    stored or logged.
                  </span>
                </div>
              </div>

              <div className="task-modal-field">
                <label htmlFor="git-push-url">GitHub HTTPS URL</label>
                <input
                  id="git-push-url"
                  type="url"
                  value={pushRepoUrl}
                  onChange={(e) => setPushRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repository"
                  required
                />
              </div>

              <div className="task-modal-field">
                <label htmlFor="git-push-branch">Target branch</label>
                <input
                  id="git-push-branch"
                  type="text"
                  value={pushBranch}
                  onChange={(e) => setPushBranch(e.target.value)}
                  placeholder="main"
                  required
                />
              </div>

              <div className="task-modal-field">
                <label htmlFor="git-push-pat">GitHub Personal Access Token (PAT)</label>
                <input
                  id="git-push-pat"
                  type="password"
                  autoComplete="off"
                  value={pushPat}
                  onChange={(e) => setPushPat(e.target.value)}
                  placeholder="ghp_... or github_pat_..."
                  required
                />
              </div>

              {pushError && <div className="files-modal-error">{pushError}</div>}

              <div className="modal-footer task-modal-footer">
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={pushingGit}
                  onClick={() => {
                    setPushPat("")
                    setGitPushOpen(false)
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={pushingGit}>
                  {pushingGit ? (
                    <>
                      <LoaderCircle className="spin" size={14} /> Pushing commit…
                    </>
                  ) : (
                    <>
                      <UploadCloud size={14} /> Push {files.length} files
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}

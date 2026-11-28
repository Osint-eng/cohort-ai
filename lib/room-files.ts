export const MAX_ROOM_FILES = 30
export const MAX_FILE_SIZE_BYTES = 200 * 1024 // 200 KB

export const ALLOWED_TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html",
  ".py",
  ".env.example",
] as const

const SKIPPED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
])

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".js": "text/javascript",
  ".jsx": "text/jsx",
  ".css": "text/css",
  ".html": "text/html",
  ".py": "text/x-python",
  ".env.example": "text/plain",
}

export function normalizeRoomFilePath(rawPath: string): string | null {
  if (typeof rawPath !== "string") return null
  const unified = rawPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "")
  if (!unified || unified.length > 240) return null
  if (unified.includes("\0") || /[\r\n]/.test(unified)) return null

  const segments = unified.split("/").filter((s) => s.length > 0)
  if (segments.length === 0) return null

  for (const segment of segments) {
    if (segment === "." || segment === "..") return null
    if (SKIPPED_SEGMENTS.has(segment.toLowerCase())) return null
  }

  const normalized = segments.join("/")
  if (normalized.length > 240) return null
  return normalized
}

export function getMatchingExtension(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  if (lower === ".env.example" || lower.endsWith("/.env.example")) {
    return ".env.example"
  }
  const baseName = lower.split("/").pop() || ""
  for (const ext of ALLOWED_TEXT_EXTENSIONS) {
    if (ext === ".env.example") continue
    if (baseName.endsWith(ext) && baseName.length > ext.length) {
      return ext
    }
  }
  return null
}

export function isAllowedTextFilePath(rawPath: string): boolean {
  const normalized = normalizeRoomFilePath(rawPath)
  if (!normalized) return false
  return getMatchingExtension(normalized) !== null
}

export function getFileNameFromPath(normalizedPath: string): string {
  const name = normalizedPath.split("/").pop() || normalizedPath
  return name.slice(0, 120)
}

export function getMimeTypeForFile(filePath: string): string {
  const ext = getMatchingExtension(filePath)
  return (ext && MIME_BY_EXTENSION[ext]) || "text/plain"
}

export function getUtf8ByteSize(content: string): number {
  return new TextEncoder().encode(content).length
}

export function hasBinaryControlChars(content: string): boolean {
  return content.includes("\0")
}

/**
 * Produces a deterministic, Firestore-safe document ID (`file_<16 hex chars>`)
 * for a normalized relative path so re-importing updates matching files idempotently.
 */
export function buildFileIdForPath(normalizedPath: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < normalizedPath.length; i++) {
    const ch = normalizedPath.charCodeAt(i)
    h1 ^= ch
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= ch + ((i + 1) << 3)
    h2 = Math.imul(h2, 0x85ebca6b)
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0")
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0")
  return `file_${hex1}${hex2}`
}

export interface ParsedGitHubRepo {
  owner: string
  repo: string
  normalizedUrl: string
}

const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/

export function parseGitHubRepoUrl(rawUrl: string): ParsedGitHubRepo | null {
  if (typeof rawUrl !== "string") return null
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== "https:") return null
  if (parsed.username || parsed.password) return null
  const host = parsed.hostname.toLowerCase()
  if (host !== "github.com" && host !== "www.github.com") return null

  const parts = parsed.pathname.split("/").filter(Boolean)
  if (parts.length < 2) return null

  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, "")
  if (!GITHUB_OWNER_REGEX.test(owner) || !GITHUB_REPO_REGEX.test(repo)) {
    return null
  }
  if (repo === "." || repo === "..") return null

  return {
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  }
}

export function normalizeGitBranch(rawBranch: unknown, fallback = "main"): string {
  if (typeof rawBranch !== "string") return fallback
  const trimmed = rawBranch.trim()
  if (!trimmed) return fallback
  if (
    trimmed.length > 120 ||
    trimmed.startsWith("-") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    /[\s~^:?*[\]\\@{}\0]/.test(trimmed)
  ) {
    throw new Error("Invalid branch name.")
  }
  return trimmed
}

export type FileValidationResult =
  | {
      ok: true
      path: string
      name: string
      mimeType: string
      size: number
      content: string
    }
  | {
      ok: false
      error: string
    }

export function validateRoomFileInput(rawPath: string, content: string): FileValidationResult {
  const path = normalizeRoomFilePath(rawPath)
  if (!path) {
    return {
      ok: false,
      error: "Enter a valid relative file path (for example, src/app.ts or README.md).",
    }
  }
  if (!isAllowedTextFilePath(path)) {
    return {
      ok: false,
      error: `Unsupported file type. Allowed extensions: ${ALLOWED_TEXT_EXTENSIONS.join(", ")}`,
    }
  }
  if (typeof content !== "string" || hasBinaryControlChars(content)) {
    return {
      ok: false,
      error: "Only plain UTF-8 text files are supported.",
    }
  }
  const size = getUtf8ByteSize(content)
  if (size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: `File exceeds the 200KB text limit (${Math.ceil(size / 1024)}KB).`,
    }
  }
  return {
    ok: true,
    path,
    name: getFileNameFromPath(path),
    mimeType: getMimeTypeForFile(path),
    size,
    content,
  }
}

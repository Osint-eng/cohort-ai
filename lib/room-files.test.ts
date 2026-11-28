import { describe, expect, it } from "vitest"
import {
  buildFileIdForPath,
  isAllowedTextFilePath,
  MAX_FILE_SIZE_BYTES,
  normalizeGitBranch,
  normalizeRoomFilePath,
  parseGitHubRepoUrl,
  validateRoomFileInput,
} from "./room-files"

describe("room-files path normalization and filtering", () => {
  it("normalizes clean relative paths and strips leading ./ or /", () => {
    expect(normalizeRoomFilePath("./src/app.ts")).toBe("src/app.ts")
    expect(normalizeRoomFilePath("/README.md")).toBe("README.md")
    expect(normalizeRoomFilePath("src\\styles\\main.css")).toBe("src/styles/main.css")
  })

  it("rejects traversal, null bytes, and skipped directories like node_modules or .git", () => {
    expect(normalizeRoomFilePath("../secrets.txt")).toBeNull()
    expect(normalizeRoomFilePath("src/../../etc/passwd")).toBeNull()
    expect(normalizeRoomFilePath(".git/config")).toBeNull()
    expect(normalizeRoomFilePath("node_modules/pkg/index.js")).toBeNull()
    expect(normalizeRoomFilePath("apps/web/node_modules/foo.ts")).toBeNull()
    expect(normalizeRoomFilePath("dist/bundle.js")).toBeNull()
    expect(normalizeRoomFilePath("src/bad\0.ts")).toBeNull()
  })

  it("allows only supported MVP text extensions including .env.example", () => {
    const allowed = [
      "README.md",
      "notes.txt",
      "package.json",
      "src/index.ts",
      "components/Card.tsx",
      "scripts/run.js",
      "src/App.jsx",
      "styles/app.css",
      "public/index.html",
      "main.py",
      ".env.example",
      "config/.env.example",
    ]
    for (const p of allowed) {
      expect(isAllowedTextFilePath(p)).toBe(true)
    }

    const rejected = [
      "logo.png",
      "photo.jpg",
      "binary.exe",
      "archive.zip",
      "font.woff2",
      ".env",
      ".env.local",
      "Makefile",
      ".ts",
    ]
    for (const p of rejected) {
      expect(isAllowedTextFilePath(p)).toBe(false)
    }
  })

  it("validates 200KB UTF-8 text limit and rejects binary null bytes", () => {
    const okResult = validateRoomFileInput("src/hello.ts", "export const hi = 'hello'\n")
    expect(okResult.ok).toBe(true)
    if (okResult.ok) {
      expect(okResult.mimeType).toBe("text/typescript")
      expect(okResult.name).toBe("hello.ts")
    }

    const oversized = "a".repeat(MAX_FILE_SIZE_BYTES + 1)
    const sizeResult = validateRoomFileInput("big.txt", oversized)
    expect(sizeResult.ok).toBe(false)

    const binaryResult = validateRoomFileInput("bad.txt", "abc\0def")
    expect(binaryResult.ok).toBe(false)
  })

  it("produces deterministic Firestore-safe file IDs", () => {
    const a1 = buildFileIdForPath("src/index.ts")
    const a2 = buildFileIdForPath("src/index.ts")
    const b = buildFileIdForPath("README.md")
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).toMatch(/^file_[0-9a-f]{16}$/)
  })
})

describe("parseGitHubRepoUrl & normalizeGitBranch", () => {
  it("accepts public HTTPS GitHub URLs with optional .git suffix", () => {
    expect(parseGitHubRepoUrl("https://github.com/Osint-eng/cohort-ai")).toEqual({
      owner: "Osint-eng",
      repo: "cohort-ai",
      normalizedUrl: "https://github.com/Osint-eng/cohort-ai",
    })
    expect(parseGitHubRepoUrl("https://github.com/octocat/Hello-World.git")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
      normalizedUrl: "https://github.com/octocat/Hello-World",
    })
  })

  it("rejects non-HTTPS, non-GitHub, embedded credentials, and malformed URLs", () => {
    expect(parseGitHubRepoUrl("http://github.com/owner/repo")).toBeNull()
    expect(parseGitHubRepoUrl("https://gitlab.com/owner/repo")).toBeNull()
    expect(parseGitHubRepoUrl("https://user:pass@github.com/owner/repo")).toBeNull()
    expect(parseGitHubRepoUrl("https://github.com/onlyowner")).toBeNull()
    expect(parseGitHubRepoUrl("git@github.com:owner/repo.git")).toBeNull()
  })

  it("validates git branch names", () => {
    expect(normalizeGitBranch("", "main")).toBe("main")
    expect(normalizeGitBranch("feature/files-tab", "main")).toBe("feature/files-tab")
    expect(() => normalizeGitBranch("bad..branch", "main")).toThrow()
    expect(() => normalizeGitBranch("-flag", "main")).toThrow()
    expect(() => normalizeGitBranch("has spaces", "main")).toThrow()
  })
})

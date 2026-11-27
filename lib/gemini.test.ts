import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
}))

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>()
  class MockGoogleGenAI {
    models = {
      generateContent: mocks.generateContent,
    }
  }
  return {
    ...actual,
    GoogleGenAI: MockGoogleGenAI,
  }
})

import { ApiError } from "@google/genai"
import {
  callGenerateContent,
  computeGeminiAttemptTimeoutMs,
  computeGeminiRetryDelayMs,
  extractBoardWithGemini,
  GeminiBadOutputError,
  GeminiQuotaError,
  generateCheckInWithGemini,
  generateProactiveNudgeWithGemini,
  generateSandboxStarterWithGemini,
} from "./gemini"

describe("lib/gemini wrapper", () => {
  const originalKey = process.env.GEMINI_API_KEY

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key"
    mocks.generateContent.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY
    } else {
      process.env.GEMINI_API_KEY = originalKey
    }
  })

  it("passes configured maxOutputTokens for extract, check-in, nudge, and sandbox", async () => {
    mocks.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        summary: "Test summary",
        tasks: [
          {
            id: "t1",
            title: "Build UI",
            description: "Build component",
            task_type: "frontend",
            weight: 2,
            suggested_owner: "@Alice",
            owner_uid: "u1",
            due_date: "Nov 30",
            status: "todo",
          },
        ],
      }),
    })

    await extractBoardWithGemini({
      brief: "Build UI",
      members: [{ uid: "u1", displayName: "Alice" }],
      existingTitle: "Room",
      todayIso: "2026-11-26",
    })
    expect(mocks.generateContent.mock.calls[0]?.[0]?.config?.maxOutputTokens).toBe(4000)

    mocks.generateContent.mockResolvedValueOnce({ text: "Check-in ok" })
    await generateCheckInWithGemini({
      roomTitle: "Room",
      tasks: [],
      members: [],
      todayIso: "2026-11-26",
    })
    expect(mocks.generateContent.mock.calls[1]?.[0]?.config?.maxOutputTokens).toBe(600)

    mocks.generateContent.mockResolvedValueOnce({ text: "Nudge ok" })
    await generateProactiveNudgeWithGemini({
      roomTitle: "Room",
      reason: "room_idle",
      summaryContext: "Quiet room",
      tasks: [],
      members: [],
      todayIso: "2026-11-26",
    })
    expect(mocks.generateContent.mock.calls[2]?.[0]?.config?.maxOutputTokens).toBe(300)

    mocks.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        primaryCode: "export default function App() { return null }",
        secondaryCode: "body {}",
        extraCode: "",
      }),
    })
    await generateSandboxStarterWithGemini({
      roomTitle: "Room",
      projectSummary: "Summary",
      taskId: "t1",
      taskTitle: "Build UI",
      taskDescription: "Build it",
      taskType: "frontend",
      templateMode: "react",
      owner: "@Alice",
      dueDate: "Nov 30",
    })
    expect(mocks.generateContent.mock.calls[3]?.[0]?.config?.maxOutputTokens).toBe(8000)
  })

  it("retries once on 503 and succeeds when the retry succeeds", async () => {
    vi.useFakeTimers()
    mocks.generateContent
      .mockRejectedValueOnce(new ApiError({ message: "Unavailable", status: 503 }))
      .mockResolvedValueOnce({ text: "Recovered check-in" })

    const promise = generateCheckInWithGemini({
      roomTitle: "Room",
      tasks: [],
      members: [],
      todayIso: "2026-11-26",
    })

    await vi.advanceTimersByTimeAsync(1000)
    const reply = await promise

    expect(reply).toBe("Recovered check-in")
    expect(mocks.generateContent).toHaveBeenCalledTimes(2)
  })

  it("retries up to 2 times on 429 and throws GeminiQuotaError after three consecutive 429s", async () => {
    vi.useFakeTimers()
    mocks.generateContent
      .mockRejectedValueOnce(new ApiError({ message: "Quota exceeded", status: 429 }))
      .mockRejectedValueOnce(new ApiError({ message: "Quota exceeded", status: 429 }))
      .mockRejectedValueOnce(new ApiError({ message: "Quota exceeded", status: 429 }))

    const promise = generateCheckInWithGemini({
      roomTitle: "Room",
      tasks: [],
      members: [],
      todayIso: "2026-11-26",
    })

    const assertion = expect(promise).rejects.toBeInstanceOf(GeminiQuotaError)
    await vi.advanceTimersByTimeAsync(2_000)
    await assertion
    expect(mocks.generateContent).toHaveBeenCalledTimes(3)
  })

  it("aborts after 25 seconds and throws GeminiBadOutputError", async () => {
    vi.useFakeTimers()
    mocks.generateContent.mockImplementationOnce(
      ({ config }: { config?: { abortSignal?: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          config?.abortSignal?.addEventListener("abort", () => {
            const err = new Error("Aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
    )

    const promise = generateProactiveNudgeWithGemini({
      roomTitle: "Room",
      reason: "room_idle",
      summaryContext: "Quiet room",
      tasks: [],
      members: [],
      todayIso: "2026-11-26",
    })

    const assertion = expect(promise).rejects.toBeInstanceOf(GeminiBadOutputError)
    await vi.advanceTimersByTimeAsync(25_000)
    await assertion
    expect(mocks.generateContent).toHaveBeenCalledTimes(1)
  })

  it("throws GeminiBadOutputError on malformed JSON from extract or sandbox", async () => {
    mocks.generateContent.mockResolvedValueOnce({ text: "{not valid json" })
    await expect(
      extractBoardWithGemini({
        brief: "Test brief",
        members: [],
        existingTitle: "Room",
        todayIso: "2026-11-26",
      })
    ).rejects.toBeInstanceOf(GeminiBadOutputError)

    mocks.generateContent.mockResolvedValueOnce({ text: "<<<broken>>>" })
    await expect(
      generateSandboxStarterWithGemini({
        roomTitle: "Room",
        projectSummary: "Summary",
        taskId: "t1",
        taskTitle: "Build UI",
        taskDescription: "Build it",
        taskType: "frontend",
        templateMode: "react",
        owner: "@Alice",
        dueDate: "Nov 30",
      })
    ).rejects.toBeInstanceOf(GeminiBadOutputError)
  })

  it("accepts YYYY-MM-DD due_date values and falls back non-ISO values to TBD", async () => {
    mocks.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        summary: "Test summary",
        tasks: [
          {
            id: "t1",
            title: "ISO due date task",
            description: "Valid date",
            task_type: "frontend",
            weight: 1,
            suggested_owner: "@Alice",
            owner_uid: "u1",
            due_date: "2026-11-28",
            status: "todo",
          },
          {
            id: "t2",
            title: "Legacy due date task",
            description: "Non-ISO date",
            task_type: "backend",
            weight: 2,
            suggested_owner: "@Alice",
            owner_uid: "u1",
            due_date: "Nov 30",
            status: "todo",
          },
        ],
      }),
    })

    const result = await extractBoardWithGemini({
      brief: "Do both tasks",
      members: [{ uid: "u1", displayName: "Alice" }],
      existingTitle: "Room",
      todayIso: "2026-11-27",
    })

    expect(result.tasks[0]?.due_date).toBe("2026-11-28")
    expect(result.tasks[1]?.due_date).toBe("TBD")
  })
})

describe("Formula G6: callGenerateContent backoff, jitter, and budget", () => {
  const originalKey = process.env.GEMINI_API_KEY

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key"
    mocks.generateContent.mockReset()
  })

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY
    } else {
      process.env.GEMINI_API_KEY = originalKey
    }
  })

  it("uses delays 500 and 1000 ms when random jitter is 0", async () => {
    const delays: number[] = []
    let nowMs = 1_000_000

    mocks.generateContent
      .mockRejectedValueOnce(new ApiError({ message: "Rate limit", status: 429 }))
      .mockRejectedValueOnce(new ApiError({ message: "Unavailable", status: 503 }))
      .mockResolvedValueOnce({ text: "ok" })

    const res = await callGenerateContent({
      contents: "hi",
      maxOutputTokens: 300,
      deps: {
        now: () => nowMs,
        randomJitterMs: () => 0,
        sleep: async (ms) => {
          delays.push(ms)
          nowMs += ms
        },
      },
    })

    expect(res.text).toBe("ok")
    expect(delays).toEqual([500, 1000])
    expect(mocks.generateContent).toHaveBeenCalledTimes(3)
    expect(computeGeminiRetryDelayMs(0, 0)).toBe(500)
    expect(computeGeminiRetryDelayMs(1, 0)).toBe(1000)
  })

  it("uses delays 749 and 1249 ms when random jitter is 249", async () => {
    const delays: number[] = []
    let nowMs = 2_000_000

    mocks.generateContent
      .mockRejectedValueOnce(new ApiError({ message: "Rate limit", status: 429 }))
      .mockRejectedValueOnce(new ApiError({ message: "Rate limit", status: 429 }))
      .mockRejectedValueOnce(new ApiError({ message: "Rate limit", status: 429 }))

    await expect(
      callGenerateContent({
        contents: "hi",
        maxOutputTokens: 300,
        deps: {
          now: () => nowMs,
          randomJitterMs: () => 249,
          sleep: async (ms) => {
            delays.push(ms)
            nowMs += ms
          },
        },
      })
    ).rejects.toBeInstanceOf(GeminiQuotaError)

    expect(delays).toEqual([749, 1249])
    expect(mocks.generateContent).toHaveBeenCalledTimes(3)
    expect(computeGeminiRetryDelayMs(0, 249)).toBe(749)
    expect(computeGeminiRetryDelayMs(1, 249)).toBe(1249)
  })

  it("never retries a 400 error", async () => {
    const delays: number[] = []
    const badReq = new ApiError({ message: "Bad request", status: 400 })
    mocks.generateContent.mockRejectedValueOnce(badReq)

    await expect(
      callGenerateContent({
        contents: "hi",
        maxOutputTokens: 300,
        deps: {
          now: () => 0,
          randomJitterMs: () => 0,
          sleep: async (ms) => {
            delays.push(ms)
          },
        },
      })
    ).rejects.toBe(badReq)

    expect(delays).toEqual([])
    expect(mocks.generateContent).toHaveBeenCalledTimes(1)
  })

  it("stops retrying when remaining budget is below 5 s and caps per-attempt timeout", async () => {
    expect(computeGeminiAttemptTimeoutMs(0)).toBe(25_000)
    expect(computeGeminiAttemptTimeoutMs(20_000)).toBe(20_000)

    const delays: number[] = []
    let nowMs = 0

    mocks.generateContent.mockImplementationOnce(async () => {
      nowMs = 36_000 // only 4_000 ms remaining (< 5_000 ms)
      throw new ApiError({ message: "Rate limit", status: 429 })
    })

    await expect(
      callGenerateContent({
        contents: "hi",
        maxOutputTokens: 300,
        deps: {
          now: () => nowMs,
          randomJitterMs: () => 0,
          sleep: async (ms) => {
            delays.push(ms)
            nowMs += ms
          },
        },
      })
    ).rejects.toBeInstanceOf(GeminiQuotaError)

    expect(delays).toEqual([])
    expect(mocks.generateContent).toHaveBeenCalledTimes(1)
  })
})


import { fsCommit, fsGetDocument } from "@/lib/server-firebase"

export class RateLimitError extends Error {
  retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.name = "RateLimitError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type BucketKey = "room" | "cohort"

const LIMITS: Record<BucketKey, { max: number; windowMs: number; label: string }> = {
  room: { max: 10, windowMs: 10 * 60 * 1000, label: "room creation" },
  cohort: { max: 20, windowMs: 10 * 60 * 1000, label: "@cohort AI commands" },
}

// Fast in-memory sliding window guard (prevents rapid bursts before hitting Firestore/Gemini)
const memoryBuckets = new Map<string, number[]>()

function checkMemoryRateLimit(uid: string, bucket: BucketKey): void {
  const { max, windowMs, label } = LIMITS[bucket]
  const key = `${uid}:${bucket}`
  const now = Date.now()
  const cutoff = now - windowMs
  const timestamps = (memoryBuckets.get(key) || []).filter((ts) => ts > cutoff)

  if (timestamps.length >= max) {
    const oldest = timestamps[0] || now
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    throw new RateLimitError(
      `Too many ${label} requests. Please wait ${retryAfterSeconds}s before trying again.`,
      retryAfterSeconds
    )
  }

  timestamps.push(now)
  memoryBuckets.set(key, timestamps)
}

export async function enforceUserRateLimit(
  uid: string,
  idToken: string,
  bucket: BucketKey
): Promise<void> {
  checkMemoryRateLimit(uid, bucket)

  const { max, windowMs, label } = LIMITS[bucket]
  const path = `rateLimits/${uid}`
  const existing = await fsGetDocument(path, idToken)
  const nowMs = Date.now()

  if (!existing) {
    await fsCommit(
      [
        {
          type: "create",
          path,
          data: {
            uid,
            roomCount: bucket === "room" ? 1 : 0,
            cohortCount: bucket === "cohort" ? 1 : 0,
          },
          serverTimestampFields: ["roomWindowStart", "cohortWindowStart", "updatedAt"],
        },
      ],
      idToken
    )
    return
  }

  const windowField = bucket === "room" ? "roomWindowStart" : "cohortWindowStart"
  const countField = bucket === "room" ? "roomCount" : "cohortCount"
  const rawWindowStart = typeof existing[windowField] === "string" ? existing[windowField] : ""
  const windowStartMs = rawWindowStart ? Date.parse(rawWindowStart) : 0
  const currentCount = typeof existing[countField] === "number" ? existing[countField] : 0
  const windowExpired = !windowStartMs || nowMs - windowStartMs > windowMs

  if (!windowExpired && currentCount >= max) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStartMs + windowMs - nowMs) / 1000)
    )
    throw new RateLimitError(
      `You’ve reached the limit for ${label}. Please wait ${Math.ceil(retryAfterSeconds / 60)} minute(s) and try again.`,
      retryAfterSeconds
    )
  }

  if (windowExpired) {
    await fsCommit(
      [
        {
          type: "update",
          path,
          data: {
            [countField]: 1,
          },
          serverTimestampFields: [windowField, "updatedAt"],
          updateMaskFields: [countField],
        },
      ],
      idToken
    )
  } else {
    await fsCommit(
      [
        {
          type: "update",
          path,
          data: {
            [countField]: currentCount + 1,
          },
          serverTimestampFields: ["updatedAt"],
          updateMaskFields: [countField],
        },
      ],
      idToken
    )
  }
}

import {
  FirestoreConflictError,
  fsCommit,
  fsGetDocumentWithMeta,
  type CommitWriteOp,
} from "./server-firebase"

export class RateLimitError extends Error {
  retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.name = "RateLimitError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type BucketKey = "room" | "cohort"

const WINDOW_MS = 10 * 60 * 1000

const LIMITS: Record<
  BucketKey,
  {
    max: number
    windowMs: number
    label: string
    countField: "roomCount" | "cohortCount"
    windowField: "roomWindowStart" | "cohortWindowStart"
  }
> = {
  room: {
    max: 10,
    windowMs: WINDOW_MS,
    label: "room creation",
    countField: "roomCount",
    windowField: "roomWindowStart",
  },
  cohort: {
    max: 20,
    windowMs: WINDOW_MS,
    label: "@cohort AI commands",
    countField: "cohortCount",
    windowField: "cohortWindowStart",
  },
}

export async function enforceUserRateLimit(
  uid: string,
  idToken: string,
  bucket: BucketKey
): Promise<void> {
  const { max, windowMs, label, countField, windowField } = LIMITS[bucket]
  const docPath = `rateLimits/${uid}`

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await fsGetDocumentWithMeta(docPath, idToken)

    let writeOp: CommitWriteOp
    if (!existing) {
      writeOp = {
        type: "create",
        path: docPath,
        data: {
          uid,
          roomCount: bucket === "room" ? 1 : 0,
          cohortCount: bucket === "cohort" ? 1 : 0,
        },
        serverTimestampFields: ["roomWindowStart", "cohortWindowStart", "updatedAt"],
      }
    } else {
      const now = Date.now()
      const rawCount = existing.data[countField]
      const currentCount =
        typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : 0
      const rawWindowStart = existing.data[windowField]
      const windowStartMs =
        typeof rawWindowStart === "string" ? Date.parse(rawWindowStart) : Number.NaN
      const windowExpired = Number.isNaN(windowStartMs) || now - windowStartMs >= windowMs

      if (!windowExpired && currentCount >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - now) / 1000))
        throw new RateLimitError(
          `Too many ${label} requests. Please wait ${retryAfterSeconds}s before trying again.`,
          retryAfterSeconds
        )
      }

      writeOp = windowExpired
        ? {
            type: "update",
            path: docPath,
            data: { [countField]: 1 },
            updateMaskFields: [countField],
            serverTimestampFields: [windowField, "updatedAt"],
            ifMatchUpdateTime: existing.updateTime,
          }
        : {
            type: "update",
            path: docPath,
            data: { [countField]: currentCount + 1 },
            updateMaskFields: [countField],
            serverTimestampFields: ["updatedAt"],
            ifMatchUpdateTime: existing.updateTime,
          }
    }

    try {
      await fsCommit([writeOp], idToken)
      return
    } catch (error) {
      if (error instanceof FirestoreConflictError && attempt === 0) {
        continue
      }
      throw error
    }
  }
}

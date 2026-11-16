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
  room: { max: 15, windowMs: 10 * 60 * 1000, label: "room creation" },
  cohort: { max: 30, windowMs: 10 * 60 * 1000, label: "@cohort AI commands" },
}

// Server-side per-user sliding window limiter (no Firestore roundtrip or permission dependency)
const memoryBuckets = new Map<string, number[]>()

export async function enforceUserRateLimit(
  uid: string,
  _idToken: string,
  bucket: BucketKey
): Promise<void> {
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

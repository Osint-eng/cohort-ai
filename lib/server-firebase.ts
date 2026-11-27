import crypto from "node:crypto"
import firebaseConfig from "../firebase-applet-config.json"

const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"

let cachedCerts: { certs: Record<string, string>; expiresAt: number } | null = null

async function getFirebasePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now()
  if (cachedCerts && now < cachedCerts.expiresAt) {
    return cachedCerts.certs
  }
  const res = await fetch(CERTS_URL, { cache: "no-store" })
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase public certificates (${res.status})`)
  }
  const certs = (await res.json()) as Record<string, string>
  const cacheControl = res.headers.get("cache-control") || ""
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/)
  const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600
  cachedCerts = {
    certs,
    expiresAt: now + Math.max(60, maxAgeSec) * 1000,
  }
  return certs
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4)
  return Buffer.from(padded, "base64")
}

export class AuthVerificationError extends Error {
  status: number
  constructor(message: string, status = 401) {
    super(message)
    this.name = "AuthVerificationError"
    this.status = status
  }
}

export class FirestoreConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FirestoreConflictError"
  }
}

export interface VerifiedFirebaseUser {
  uid: string
  displayName: string
  photoURL: string
  email: string
  idToken: string
}

export async function verifyFirebaseIdToken(authHeader: string | null): Promise<VerifiedFirebaseUser> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthVerificationError("Missing Authorization Bearer token", 401)
  }
  const idToken = authHeader.slice("Bearer ".length).trim()
  const parts = idToken.split(".")
  if (parts.length !== 3) {
    throw new AuthVerificationError("Invalid JWT format", 401)
  }

  const [headerB64, payloadB64, sigB64] = parts
  let header: { alg?: string; kid?: string }
  let payload: {
    aud?: string
    iss?: string
    sub?: string
    exp?: number
    iat?: number
    email?: string
    email_verified?: boolean
    name?: string
    picture?: string
  }
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as {
      alg?: string
      kid?: string
    }
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as {
      aud?: string
      iss?: string
      sub?: string
      exp?: number
      iat?: number
      email?: string
      email_verified?: boolean
      name?: string
      picture?: string
    }
  } catch {
    throw new AuthVerificationError("Invalid JWT format", 401)
  }

  if (header.alg !== "RS256" || !header.kid) {
    throw new AuthVerificationError("Unsupported JWT algorithm", 401)
  }

  const certs = await getFirebasePublicCerts()
  const certPem = certs[header.kid]
  if (!certPem) {
    throw new AuthVerificationError("Unknown JWT key ID", 401)
  }

  const verifier = crypto.createVerify("RSA-SHA256")
  verifier.update(`${headerB64}.${payloadB64}`)
  verifier.end()
  const isValid = verifier.verify(certPem, base64UrlDecode(sigB64))
  if (!isValid) {
    throw new AuthVerificationError("Invalid Firebase ID token signature", 401)
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const expectedIssuer = `https://securetoken.google.com/${firebaseConfig.projectId}`
  if (payload.aud !== firebaseConfig.projectId || payload.iss !== expectedIssuer) {
    throw new AuthVerificationError("Invalid token audience or issuer", 401)
  }
  if (!payload.sub || typeof payload.sub !== "string") {
    throw new AuthVerificationError("Missing token subject", 401)
  }
  if (!payload.exp || nowSec >= payload.exp) {
    throw new AuthVerificationError("Firebase ID token has expired", 401)
  }
  if (payload.email_verified !== true) {
    throw new AuthVerificationError(
      "Your Google account email is not verified. Cohort requires a Google account with a verified email address.",
      403
    )
  }

  const fallbackName = payload.email ? payload.email.split("@")[0] : "Teammate"
  const displayName = (payload.name || fallbackName || "Teammate").trim().slice(0, 80)

  return {
    uid: payload.sub,
    displayName,
    photoURL: (payload.picture || "").slice(0, 500),
    email: payload.email || "",
    idToken,
  }
}

const FIRESTORE_DOC_PREFIX = `projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/${FIRESTORE_DOC_PREFIX}`

export type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } }

export function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null }
  if (typeof value === "string") return { stringValue: value }
  if (typeof value === "boolean") return { booleanValue: value }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } }
  }
  if (typeof value === "object") {
    const fields: Record<string, FirestoreValue> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v)
    }
    return { mapValue: { fields } }
  }
  return { stringValue: String(value) }
}

export function fromFirestoreValue(val: FirestoreValue): unknown {
  if ("stringValue" in val) return val.stringValue
  if ("integerValue" in val) return Number(val.integerValue)
  if ("doubleValue" in val) return val.doubleValue
  if ("booleanValue" in val) return val.booleanValue
  if ("timestampValue" in val) return val.timestampValue
  if ("nullValue" in val) return null
  if ("arrayValue" in val) return (val.arrayValue.values || []).map(fromFirestoreValue)
  if ("mapValue" in val) {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      obj[k] = fromFirestoreValue(v)
    }
    return obj
  }
  return null
}

function decodeFirestoreDoc(docObj: { name: string; fields?: Record<string, FirestoreValue> }) {
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(docObj.fields || {})) {
    data[k] = fromFirestoreValue(v)
  }
  const docId = docObj.name.split("/").pop() || ""
  return { docId, data }
}

export function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v)
  }
  return fields
}

export function fullDocumentName(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "")
  return `${FIRESTORE_DOC_PREFIX}/${clean}`
}

export async function fsGetDocumentWithMeta(
  relativePath: string,
  idToken: string
): Promise<{ data: Record<string, unknown>; updateTime?: string } | null> {
  const clean = relativePath.replace(/^\/+/, "")
  const res = await fetch(`${FIRESTORE_BASE_URL}/${clean}`, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: "no-store",
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Firestore GET ${clean} failed (${res.status}): ${text}`)
  }
  const json = (await res.json()) as {
    name: string
    fields?: Record<string, FirestoreValue>
    updateTime?: string
  }
  return {
    data: decodeFirestoreDoc(json).data,
    updateTime: json.updateTime,
  }
}

export async function fsGetDocument(
  relativePath: string,
  idToken: string
): Promise<Record<string, unknown> | null> {
  const res = await fsGetDocumentWithMeta(relativePath, idToken)
  return res ? res.data : null
}

export async function fsListCollection(
  relativeCollectionPath: string,
  idToken: string
): Promise<Array<{ docId: string; data: Record<string, unknown> }>> {
  const clean = relativeCollectionPath.replace(/^\/+/, "")
  const res = await fetch(`${FIRESTORE_BASE_URL}/${clean}?pageSize=100`, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: "no-store",
  })
  if (res.status === 404) return []
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Firestore LIST ${clean} failed (${res.status}): ${text}`)
  }
  const json = (await res.json()) as {
    documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>
  }
  return (json.documents || []).map(decodeFirestoreDoc)
}

export interface RunQueryOptions {
  parentPath?: string
  collectionId: string
  orderBy?: Array<{ fieldPath: string; direction?: "ASCENDING" | "DESCENDING" }>
  limit?: number
}

export async function fsRunQuery(
  options: RunQueryOptions,
  idToken: string
): Promise<Array<{ docId: string; data: Record<string, unknown> }>> {
  const cleanParent = (options.parentPath || "").replace(/^\/+|\/+$/g, "")
  const url = cleanParent
    ? `${FIRESTORE_BASE_URL}/${cleanParent}:runQuery`
    : `${FIRESTORE_BASE_URL}:runQuery`

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: options.collectionId }],
  }
  if (options.orderBy?.length) {
    structuredQuery.orderBy = options.orderBy.map((o) => ({
      field: { fieldPath: o.fieldPath },
      direction: o.direction || "ASCENDING",
    }))
  }
  if (typeof options.limit === "number") {
    structuredQuery.limit = options.limit
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ structuredQuery }),
    cache: "no-store",
  })

  if (res.status === 404) return []
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Firestore RUN_QUERY ${options.collectionId} failed (${res.status}): ${text}`)
  }

  const rows = (await res.json()) as Array<{
    document?: { name: string; fields?: Record<string, FirestoreValue> }
  }>

  return rows
    .filter(
      (row): row is { document: { name: string; fields?: Record<string, FirestoreValue> } } =>
        Boolean(row.document)
    )
    .map((row) => decodeFirestoreDoc(row.document))
}

export interface CommitWriteOp {
  type: "create" | "set" | "update" | "delete"
  path: string
  data?: Record<string, unknown>
  serverTimestampFields?: string[]
  updateMaskFields?: string[]
  ifMatchUpdateTime?: string
}

export async function fsCommit(writes: CommitWriteOp[], idToken: string): Promise<void> {
  if (writes.length === 0) return

  const firestoreWrites = writes.map((op) => {
    const docName = fullDocumentName(op.path)
    if (op.type === "delete") {
      return { delete: docName }
    }
    const writeObj: Record<string, unknown> = {
      update: {
        name: docName,
        fields: toFirestoreFields(op.data || {}),
      },
    }
    if (op.type === "create") {
      writeObj.currentDocument = { exists: false }
    } else if (op.type === "update" && op.updateMaskFields?.length) {
      writeObj.currentDocument = op.ifMatchUpdateTime
        ? { updateTime: op.ifMatchUpdateTime }
        : { exists: true }
      writeObj.updateMask = { fieldPaths: op.updateMaskFields }
    }
    if (op.serverTimestampFields?.length) {
      writeObj.updateTransforms = op.serverTimestampFields.map((fieldPath) => ({
        fieldPath,
        setToServerValue: "REQUEST_TIME",
      }))
    }
    return writeObj
  })

  const res = await fetch(`${FIRESTORE_BASE_URL}:commit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ writes: firestoreWrites }),
    cache: "no-store",
  })

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 409 || text.includes("ALREADY_EXISTS") || text.includes("FAILED_PRECONDITION")) {
      throw new FirestoreConflictError(`Firestore precondition conflict: ${text}`)
    }
    throw new Error(`Firestore commit failed (${res.status}): ${text}`)
  }
}

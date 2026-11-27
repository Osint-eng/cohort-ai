import crypto from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import firebaseConfig from "../firebase-applet-config.json"
import { AuthVerificationError, toFirestoreFields, verifyFirebaseIdToken } from "./server-firebase"

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
})

const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function signToken(
  header: unknown,
  payload: unknown,
  signingKey: crypto.KeyObject = privateKey
): string {
  const headerB64 = base64Url(JSON.stringify(header))
  const payloadB64 = base64Url(JSON.stringify(payload))
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(`${headerB64}.${payloadB64}`)
  signer.end()
  const sigB64 = base64Url(signer.sign(signingKey))
  return `${headerB64}.${payloadB64}.${sigB64}`
}

function validPayload(overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    aud: firebaseConfig.projectId,
    iss: `https://securetoken.google.com/${firebaseConfig.projectId}`,
    sub: "user_123",
    iat: nowSec - 60,
    exp: nowSec + 3600,
    email: "alice@example.com",
    email_verified: true,
    name: "Alice Example",
    picture: "https://example.com/alice.png",
    ...overrides,
  }
}

describe("verifyFirebaseIdToken", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ "kid-1": publicKeyPem }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
          },
        })
      )
    )
  })

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch)
    vi.restoreAllMocks()
  })

  it("verifies a valid RS256 Firebase ID token", async () => {
    const token = signToken({ alg: "RS256", kid: "kid-1" }, validPayload())
    const user = await verifyFirebaseIdToken(`Bearer ${token}`)
    expect(user).toEqual({
      uid: "user_123",
      displayName: "Alice Example",
      photoURL: "https://example.com/alice.png",
      email: "alice@example.com",
      idToken: token,
    })
  })

  it("throws AuthVerificationError(401) for every token failure", async () => {
    const otherPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    const nowSec = Math.floor(Date.now() / 1000)

    const failingHeaders: Array<[string, string | null]> = [
      ["missing header", null],
      ["non-bearer header", "Basic abc"],
      ["bad jwt format", "Bearer not.a.valid.jwt"],
      ["empty jwt segment", "Bearer hdr.pay."],
      ["non-json header", `Bearer ${base64Url("{bad")}.${base64Url("{}")}.sig`],
      ["null json payload", `Bearer ${base64Url(JSON.stringify({ alg: "RS256", kid: "kid-1" }))}.${base64Url("null")}.sig`],
      ["unsupported alg", `Bearer ${signToken({ alg: "HS256", kid: "kid-1" }, validPayload())}`],
      ["missing kid", `Bearer ${signToken({ alg: "RS256" }, validPayload())}`],
      ["unknown kid", `Bearer ${signToken({ alg: "RS256", kid: "unknown-kid" }, validPayload())}`],
      ["bad signature", `Bearer ${signToken({ alg: "RS256", kid: "kid-1" }, validPayload(), otherPair.privateKey)}`],
      ["wrong audience", `Bearer ${signToken({ alg: "RS256", kid: "kid-1" }, validPayload({ aud: "other-project" }))}`],
      ["wrong issuer", `Bearer ${signToken({ alg: "RS256", kid: "kid-1" }, validPayload({ iss: "https://securetoken.google.com/other" }))}`],
      ["missing sub", `Bearer ${signToken({ alg: "RS256", kid: "kid-1" }, validPayload({ sub: "" }))}`],
      ["expired token", `Bearer ${signToken({ alg: "RS256", kid: "kid-1" }, validPayload({ exp: nowSec - 10 }))}`],
    ]

    for (const [label, header] of failingHeaders) {
      let caught: unknown
      try {
        await verifyFirebaseIdToken(header)
      } catch (err) {
        caught = err
      }
      expect(caught, label).toBeInstanceOf(AuthVerificationError)
      expect((caught as AuthVerificationError).status, label).toBe(401)
    }
  })

  it("throws AuthVerificationError(403) when email is not verified", async () => {
    const token = signToken(
      { alg: "RS256", kid: "kid-1" },
      validPayload({ email_verified: false })
    )
    let caught: unknown
    try {
      await verifyFirebaseIdToken(`Bearer ${token}`)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AuthVerificationError)
    expect((caught as AuthVerificationError).status).toBe(403)
  })
})

describe("toFirestoreFields", () => {
  it("encodes nested nudgeState maps with timestampValue and integerValue", () => {
    const at = new Date("2026-11-27T12:00:00.000Z")
    const encoded = toFirestoreFields({
      nudgeState: {
        t1: {
          at,
          n: 1,
        },
      },
    })

    expect(encoded).toEqual({
      nudgeState: {
        mapValue: {
          fields: {
            t1: {
              mapValue: {
                fields: {
                  at: { timestampValue: "2026-11-27T12:00:00.000Z" },
                  n: { integerValue: "1" },
                },
              },
            },
          },
        },
      },
    })
  })
})


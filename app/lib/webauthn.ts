/**
 * WebAuthn server-side helpers.
 *
 * Design decisions for this hackathon prototype:
 *
 * 1. CREDENTIALS LIVE IN THE NEXTAUTH JWT.
 *    NextAuth uses an encrypted+signed JWT (JWE) for sessions, so we can store
 *    the user's credential ID + public key in the session cookie itself. No
 *    external KV/database required. The JWT is opaque and tamper-proof from
 *    the client's perspective. One credential per user is enough for the demo.
 *
 * 2. CHALLENGES LIVE IN A SHORT-LIVED, HMAC-SIGNED COOKIE.
 *    Each register/authenticate ceremony has two HTTP round trips. We need to
 *    persist the challenge across them. A signed cookie keyed off AUTH_SECRET
 *    means we don't need an in-memory Map (which would not survive Vercel
 *    serverless function instance recycling). The challenge itself is public
 *    (it's sent to the client anyway) — we only need integrity, not secrecy.
 *
 * 3. POST-AUTH AUTHORIZATION TOKENS ARE SHORT-LIVED HMAC TOKENS.
 *    After a successful authentication ceremony we issue a 90-second auth
 *    token tied to the user's email and a specific action_kind+params hash.
 *    The /api/servicing/execute endpoint requires this token to actually run
 *    the servicing function. This is the deterministic gate that replaces the
 *    LLM-driven PAY/MOVE typed tokens.
 *
 * 4. RP ID IS DERIVED FROM THE REQUEST ORIGIN.
 *    Locally that's localhost; in production it's affirm-agent-hackathon
 *    .vercel.app. WebAuthn requires the RP ID to match the page origin host.
 */

import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

export const RP_NAME = "Affirm Servicing Assistant";

/** Pull the RP ID and origin from the request. WebAuthn requires both. */
export function getRpFromRequest(request: Request): {
  rpId: string;
  origin: string;
} {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? new URL(request.url).host;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const rpId = host.split(":")[0];
  const origin = `${proto}://${host}`;
  return { rpId, origin };
}

/**
 * Persisted credential. Lives inside the NextAuth JWT.
 * publicKey is base64url-encoded COSE key bytes.
 */
export type StoredCredential = {
  credentialId: string; // base64url
  publicKey: string; // base64url
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  registeredAt: number;
};

// ---------------------------------------------------------------------------
// HMAC cookie utilities (challenges + auth tokens)
// ---------------------------------------------------------------------------

function getSecret(): Buffer {
  const s = process.env.AUTH_SECRET;
  if (!s) {
    throw new Error("AUTH_SECRET is required for WebAuthn token signing.");
  }
  return Buffer.from(s, "utf8");
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", getSecret()).update(payload).digest());
}

function verifySignature(payload: string, signature: string): boolean {
  const expected = fromB64url(sign(payload));
  let provided: Buffer;
  try {
    provided = fromB64url(signature);
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// Challenge cookies (5 minute TTL — long enough for a single OS biometric prompt)
// ---------------------------------------------------------------------------

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type ChallengeKind = "register" | "authenticate";

export type ChallengeCookieValue = {
  kind: ChallengeKind;
  challenge: string; // base64url
  email: string;
  expiresAt: number;
};

export function makeChallenge(): string {
  return b64url(randomBytes(32));
}

export function packChallengeCookie(value: ChallengeCookieValue): string {
  const json = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const sig = sign(json);
  return `${json}.${sig}`;
}

export function unpackChallengeCookie(
  cookieValue: string | undefined
): ChallengeCookieValue | null {
  if (!cookieValue) return null;
  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return null;
  const json = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  if (!verifySignature(json, sig)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(json, "base64").toString("utf8")
    ) as ChallengeCookieValue;
    if (parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const CHALLENGE_COOKIE_NAME = "wa_challenge";

// ---------------------------------------------------------------------------
// Authorization tokens (90 second TTL — issued after successful biometric auth)
// ---------------------------------------------------------------------------

const AUTH_TOKEN_TTL_MS = 90 * 1000;

export type AuthTokenPayload = {
  email: string;
  /** Hash of (kind + params_json) so this token can only run the action it was minted for */
  actionHash: string;
  issuedAt: number;
  expiresAt: number;
};

export function mintAuthToken(email: string, actionHash: string): string {
  const payload: AuthTokenPayload = {
    email,
    actionHash,
    issuedAt: Date.now(),
    expiresAt: Date.now() + AUTH_TOKEN_TTL_MS,
  };
  const json = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const sig = sign(json);
  return `${json}.${sig}`;
}

export function verifyAuthToken(
  token: string | undefined | null,
  expected: { email: string; actionHash: string }
): { ok: true } | { ok: false; reason: string } {
  if (!token) return { ok: false, reason: "missing token" };
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return { ok: false, reason: "malformed token" };
  const json = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!verifySignature(json, sig))
    return { ok: false, reason: "bad signature" };
  let payload: AuthTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(json, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad payload" };
  }
  if (payload.expiresAt < Date.now())
    return { ok: false, reason: "token expired" };
  if (payload.email !== expected.email)
    return { ok: false, reason: "email mismatch" };
  if (payload.actionHash !== expected.actionHash)
    return { ok: false, reason: "action mismatch" };
  return { ok: true };
}

/**
 * Stable hash for action+params. Used so an auth token minted for "payoff
 * Peloton" can't be replayed against "payoff Marriott".
 *
 * We can't use JSON.stringify with a key array as the replacer — that filters
 * properties and silently drops the outer "params" key, which would make every
 * payoff token hash to the same value regardless of which loan it's for.
 * Instead, we walk the value and emit canonical (sorted-keys) JSON manually.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`
    );
    return `{${parts.join(",")}}`;
  }
  return "null";
}

export function hashAction(kind: string, params: unknown): string {
  const stable = canonicalize({ kind, params });
  return b64url(createHmac("sha256", getSecret()).update(stable).digest());
}

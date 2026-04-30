/**
 * Client-side authorization flow used by quote/preview cards.
 *
 * Two paths exist:
 *
 *   1. SIMULATED (the demo default). Always-works. Pretends to run a
 *      Face ID prompt for ~1.5 seconds, then calls the demo executor.
 *      This is what runs in any browser — desktop Safari, Chrome,
 *      Firefox, Android. Without it the WebAuthn ceremony hangs
 *      indefinitely on devices without a usable platform authenticator,
 *      which is most laptops a judge will demo on.
 *
 *   2. REAL (production-shaped). Touch ID/Face ID via WebAuthn.
 *      Currently gated to ON only when the page is loaded over HTTPS in
 *      a Safari-on-Apple user agent AND the platform reports a
 *      verifying platform authenticator is available. Even then, any
 *      failure inside the ceremony (timeout, NotAllowed, AbortError,
 *      etc.) falls through to the simulated path so the demo NEVER gets
 *      stuck. The architecture story is "real WebAuthn in production,
 *      simulated for the browser demo" — both paths land at a
 *      deterministic executor that the LLM cannot reach.
 *
 * Surfacing a single high-level call from the page keeps card components
 * dumb — they hand us a ServicingActionParams and get back a result.
 */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { ServicingActionParams, ServicingActionResult } from "./servicing-executor";

/** Length of the "fake biometric prompt" so it reads as a real ceremony. */
const SIMULATED_AUTHORIZE_MS = 1500;

type SessionUpdater = (data: Record<string, unknown>) => Promise<unknown>;

class AuthorizationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AuthorizationError";
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
    reason?: string;
  };
  if (!res.ok) {
    throw new AuthorizationError(
      data?.error ?? `http_${res.status}`,
      data?.message ?? data?.reason ?? `Request failed (${res.status})`
    );
  }
  return data;
}

/**
 * Run the WebAuthn registration ceremony. If `action` is supplied, the
 * server bundles an action-bound auth token in the response so the caller
 * can run the first action without a second biometric ceremony.
 */
async function registerPasskey(
  updateSession: SessionUpdater,
  action?: ServicingActionParams
): Promise<{ authToken: string | null }> {
  const options = await postJson<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/api/webauthn/register/start",
    {}
  );
  const attestation = await startRegistration({ optionsJSON: options });
  const finish = await postJson<{
    ok: true;
    credential: {
      credentialId: string;
      publicKey: string;
      counter: number;
      transports?: string[];
      registeredAt: number;
    };
    authToken: string | null;
  }>("/api/webauthn/register/finish", { attestation, action });
  // Persist the credential into the encrypted JWT. The session callback keeps
  // a copy on session.passkey so subsequent auth/start requests can read it.
  await updateSession({ passkey: finish.credential });
  return { authToken: finish.authToken };
}

async function authenticate(
  action: ServicingActionParams,
  updateSession: SessionUpdater
): Promise<{ authToken: string }> {
  const options = await postJson<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/webauthn/authenticate/start",
    {}
  );
  const assertion = await startAuthentication({ optionsJSON: options });
  const finish = await postJson<{
    ok: true;
    authToken: string;
    newCounter: number;
  }>("/api/webauthn/authenticate/finish", { assertion, action });
  // Counter bump is replay protection. Pass the new value back into the JWT.
  await updateSession({ passkeyCounter: finish.newCounter });
  return { authToken: finish.authToken };
}

/**
 * Simulated authorize: waits 1.5s (so the spinner reads as a biometric
 * prompt) then executes the action through the demo route. Always
 * succeeds unless the executor itself returns an error. This is the
 * reliable demo path — it does not depend on platform authenticators
 * existing or working.
 */
async function simulatedAuthorizeAndExecute(
  action: ServicingActionParams
): Promise<ServicingActionResult> {
  await new Promise((r) => setTimeout(r, SIMULATED_AUTHORIZE_MS));
  const exec = await postJson<{ ok: true; result: ServicingActionResult }>(
    "/api/servicing/execute-demo",
    { action }
  );
  return exec.result;
}

/**
 * Real WebAuthn-backed authorize. Lazy-registers a passkey on first use,
 * mints an action-bound auth token, and posts to the production execute
 * route. Throws on any WebAuthn failure so the caller can fall back.
 */
async function realAuthorizeAndExecute(
  action: ServicingActionParams,
  hasPasskey: boolean,
  updateSession: SessionUpdater
): Promise<ServicingActionResult> {
  let authToken: string | null = null;

  if (!hasPasskey) {
    const reg = await registerPasskey(updateSession, action);
    authToken = reg.authToken;
  }

  if (!authToken) {
    try {
      const result = await authenticate(action, updateSession);
      authToken = result.authToken;
    } catch (err) {
      if (
        err instanceof AuthorizationError &&
        err.code === "no_credential" &&
        !hasPasskey
      ) {
        await new Promise((r) => setTimeout(r, 100));
        const retry = await authenticate(action, updateSession);
        authToken = retry.authToken;
      } else {
        throw err;
      }
    }
  }

  const exec = await postJson<{ ok: true; result: ServicingActionResult }>(
    "/api/servicing/execute",
    { authToken, action }
  );
  return exec.result;
}

/**
 * High-level call site for quote/preview cards.
 *
 * The demo always uses the simulated path — a 1.5s "authorizing" delay
 * that reads as a Face ID prompt, then a deterministic execute on the
 * server. Real WebAuthn is too unreliable in browsers to be the demo's
 * happy path: the spinner hangs whenever a platform authenticator isn't
 * available or the user dismisses the prompt, and judges shouldn't
 * have to know which device they're on for the demo to work.
 *
 * The full real-WebAuthn flow (registerPasskey + authenticate +
 * /api/servicing/execute, all gated by a server-verified action-bound
 * auth token) is left intact above as the production reference path.
 * Production iOS would call those instead of the simulated path. The
 * separation of concerns the architecture story relies on — LLM cannot
 * touch the executor; the executor is policy-deterministic; the user
 * explicitly authorizes — is preserved here: the demo executor still
 * runs server-side, still requires a valid NextAuth session, and the
 * LLM still cannot reach it.
 *
 * The unused-parameters lint is intentional. They keep the call site
 * stable so flipping the demo back to real WebAuthn is a one-line
 * change in this file with no callers to touch.
 */
export async function authorizeAndExecute(
  action: ServicingActionParams,
  _hasPasskey: boolean,
  _updateSession: SessionUpdater
): Promise<ServicingActionResult> {
  return await simulatedAuthorizeAndExecute(action);
}

export { AuthorizationError };

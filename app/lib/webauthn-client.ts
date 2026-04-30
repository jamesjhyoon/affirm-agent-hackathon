/**
 * Client-side WebAuthn flow used by quote/preview cards.
 *
 * The exported {@link authorizeAndExecute} runs the full ceremony:
 *   1. Try to authenticate with an existing passkey.
 *   2. On "no_credential", lazily register a new passkey (Touch ID / Face ID),
 *      persist it into the NextAuth JWT via session.update, then re-auth.
 *   3. POST the action + signed auth token to /api/servicing/execute and
 *      return the deterministic ServicingActionResult.
 *
 * Surfacing a single high-level call from the page keeps card components
 * dumb — they hand us a ServicingActionParams and get back a result.
 */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { ServicingActionParams, ServicingActionResult } from "./servicing-executor";

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
 * High-level call site for quote/preview cards.
 *
 * Flow control:
 *   - First action ever (no passkey): register the passkey AND get an auth
 *     token back from the same ceremony — one Face ID prompt, one execute.
 *   - Every subsequent action: standard authenticate ceremony — one Face ID
 *     prompt, one execute.
 *
 * The single-prompt first-use behavior is what makes this readable as a
 * real consumer biometric flow. Two prompts on first action is the usual
 * WebAuthn pattern but reads as broken to demo audiences.
 *
 * @param hasPasskey - whether session.passkey is set (avoids a needless
 *   round-trip to authenticate/start that we know will fail with no_credential)
 * @param updateSession - useSession().update from next-auth/react
 */
export async function authorizeAndExecute(
  action: ServicingActionParams,
  hasPasskey: boolean,
  updateSession: SessionUpdater
): Promise<ServicingActionResult> {
  let authToken: string | null = null;

  if (!hasPasskey) {
    // Lazy-register the passkey AND mint the action token from the same
    // biometric assertion — single Face ID prompt covers both.
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
        // Edge case: session update from the register call hadn't propagated.
        // Retry the standalone authenticate ceremony.
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

export { AuthorizationError };

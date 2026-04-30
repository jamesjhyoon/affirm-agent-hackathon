import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { auth } from "@/auth";
import {
  CHALLENGE_COOKIE_NAME,
  getRpFromRequest,
  hashAction,
  mintAuthToken,
  unpackChallengeCookie,
  type StoredCredential,
} from "@/app/lib/webauthn";
import type { ServicingActionParams } from "@/app/lib/servicing-executor";

/**
 * Verify a registration response. On success we return the StoredCredential
 * payload, which the frontend persists into the NextAuth JWT.
 *
 * IMPORTANT — single-prompt first-use:
 *
 * The standard WebAuthn flow on first use is two ceremonies (register, then
 * authenticate), each with its own biometric prompt. That's two Face ID
 * prompts on the user's first action, which kills the "tap to confirm"
 * demo moment. To collapse it to one prompt, this endpoint optionally
 * accepts a servicing `action` in the request body. The registration
 * ceremony itself REQUIRES a verified user-presence + user-verification
 * assertion (we set requireUserVerification: true and userVerification:
 * "required" in start), which is the same biometric assertion we'd ask for
 * in a separate authenticate call. So when an action is provided AND
 * registration verifies, we mint an action-bound auth token right here —
 * the client uses it to call /api/servicing/execute without a second prompt.
 *
 * Subsequent actions don't go through this path; they hit
 * /api/webauthn/authenticate/{start,finish} as normal — single prompt each.
 */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { rpId, origin } = getRpFromRequest(request);
  const body = (await request.json()) as {
    attestation?: RegistrationResponseJSON;
    action?: ServicingActionParams;
  } & RegistrationResponseJSON;

  // Backward-compatible: clients may send the attestation directly OR
  // wrapped under { attestation, action }.
  const attestation = body.attestation ?? (body as RegistrationResponseJSON);
  const action = body.action;

  const cookieStore = await cookies();
  const cookie = unpackChallengeCookie(
    cookieStore.get(CHALLENGE_COOKIE_NAME)?.value
  );
  if (!cookie || cookie.kind !== "register" || cookie.email !== email) {
    return NextResponse.json(
      { error: "invalid_or_expired_challenge" },
      { status: 400 }
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: cookie.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "verification_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 400 }
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "not_verified" }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;

  const stored: StoredCredential = {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports ?? attestation.response.transports,
    registeredAt: Date.now(),
  };

  // If the client passed an action, mint a 90-second auth token bound to it
  // so the first action doesn't need a second biometric ceremony.
  let authToken: string | null = null;
  if (action && action.kind) {
    authToken = mintAuthToken(email, hashAction(action.kind, action));
  }

  const response = NextResponse.json({
    ok: true,
    credential: stored,
    authToken,
  });
  response.cookies.set(CHALLENGE_COOKIE_NAME, "", {
    path: "/",
    maxAge: 0,
  });
  return response;
}

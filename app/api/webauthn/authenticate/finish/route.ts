import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
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
 * Verify a passkey assertion against the stored credential. On success we mint
 * a 90-second auth token bound to (email, action_kind, params). The frontend
 * passes this token to /api/servicing/execute to actually run the action.
 *
 * The action binding is what makes this safe: a token minted for "payoff
 * Peloton with debit-442" can't be replayed against "payoff Marriott".
 */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const credential = (
    session as unknown as { passkey?: StoredCredential }
  ).passkey;
  if (!credential) {
    return NextResponse.json({ error: "no_credential" }, { status: 400 });
  }

  const { rpId, origin } = getRpFromRequest(request);
  const body = (await request.json()) as {
    assertion: AuthenticationResponseJSON;
    action: ServicingActionParams;
  };

  if (!body?.assertion || !body?.action?.kind) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const cookie = unpackChallengeCookie(
    cookieStore.get(CHALLENGE_COOKIE_NAME)?.value
  );
  if (!cookie || cookie.kind !== "authenticate" || cookie.email !== email) {
    return NextResponse.json(
      { error: "invalid_or_expired_challenge" },
      { status: 400 }
    );
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.assertion,
      expectedChallenge: cookie.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: credential.credentialId,
        publicKey: Buffer.from(credential.publicKey, "base64url"),
        counter: credential.counter,
        transports: credential.transports,
      },
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

  if (!verification.verified) {
    return NextResponse.json({ error: "not_verified" }, { status: 400 });
  }

  const newCounter = verification.authenticationInfo.newCounter;
  // Hash the FULL action object (not action.params) so this matches what
  // /api/servicing/execute computes when it verifies the token. The frontend
  // sends `action` as a flat ServicingActionParams (e.g. { kind, loan_id,
  // funding_source_id }), not as { kind, params: {...} }.
  const actionHash = hashAction(body.action.kind, body.action);
  const authToken = mintAuthToken(email, actionHash);

  const response = NextResponse.json({
    ok: true,
    authToken,
    newCounter,
  });
  response.cookies.set(CHALLENGE_COOKIE_NAME, "", {
    path: "/",
    maxAge: 0,
  });
  return response;
}

import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { auth } from "@/auth";
import {
  CHALLENGE_COOKIE_NAME,
  CHALLENGE_TTL_MS,
  getRpFromRequest,
  packChallengeCookie,
  type StoredCredential,
} from "@/app/lib/webauthn";

/**
 * Begin a passkey authentication ceremony. We restrict allowCredentials to
 * the user's stored credential so the OS prompts for the right key (and we
 * avoid the picker UI that "any passkey" would trigger).
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
    return NextResponse.json(
      { error: "no_credential", message: "Register a passkey first." },
      { status: 400 }
    );
  }

  const { rpId } = getRpFromRequest(request);

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: "required",
    allowCredentials: [
      {
        id: credential.credentialId,
        transports: credential.transports,
      },
    ],
  });

  const response = NextResponse.json(options);
  response.cookies.set(
    CHALLENGE_COOKIE_NAME,
    packChallengeCookie({
      kind: "authenticate",
      challenge: options.challenge,
      email,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(CHALLENGE_TTL_MS / 1000),
    }
  );
  return response;
}

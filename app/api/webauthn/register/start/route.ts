import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { auth } from "@/auth";
import {
  RP_NAME,
  CHALLENGE_COOKIE_NAME,
  CHALLENGE_TTL_MS,
  getRpFromRequest,
  packChallengeCookie,
} from "@/app/lib/webauthn";

/**
 * Begin a passkey registration ceremony for the signed-in user. The browser
 * uses the returned options to call navigator.credentials.create(), which
 * triggers the OS biometric (Touch ID / Face ID / Windows Hello) and
 * generates a fresh keypair.
 *
 * We require platform authenticators (residentKey: preferred, userVerification:
 * required, attachment: platform) — that's what gives us "real" biometric step
 * up for the demo, instead of letting users register a passkey on a
 * roaming USB key that wouldn't carry conviction in the demo video.
 */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { rpId } = getRpFromRequest(request);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userName: email,
    userDisplayName: session.user?.name ?? email,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
      authenticatorAttachment: "platform",
    },
    supportedAlgorithmIDs: [-7, -257],
  });

  const response = NextResponse.json(options);
  response.cookies.set(
    CHALLENGE_COOKIE_NAME,
    packChallengeCookie({
      kind: "register",
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

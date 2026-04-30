import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  executeServicingAction,
  type ServicingActionParams,
} from "@/app/lib/servicing-executor";

/**
 * Demo-mode servicing executor.
 *
 * Same executor as /api/servicing/execute, but skips the WebAuthn auth
 * token check. This exists because the demo runs in browsers without a
 * working platform authenticator (any non-Apple device, plus most desktop
 * Safari setups), where the real WebAuthn ceremony hangs forever and
 * leaves the "Confirm with Face ID" button spinning. The client falls
 * back to this endpoint after a 1.5-second simulated authorize delay so
 * the demo always completes end-to-end.
 *
 * Production gate: this route would NOT exist in a real Affirm app — the
 * production path is /api/servicing/execute, which requires a valid,
 * action-bound WebAuthn assertion. The session check below is the only
 * thing standing between the caller and a mock loan mutation. That's
 * fine because:
 *   1. All loans here are deterministic mock data (no real money moves)
 *   2. The LLM still cannot reach this route — only the user can,
 *      through the explicit "Confirm" button on a quote/preview card
 *   3. Authentication still requires an @affirm.com Google sign-in
 */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  const name = session?.user?.name;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: ServicingActionParams };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body?.action || !body.action.kind) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const firstName = (name ?? email).split(/[\s.@]/)[0] || "there";
  try {
    const result = await executeServicingAction(body.action, {
      userEmail: email,
      firstName,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[/api/servicing/execute-demo] executor threw:", err);
    return NextResponse.json(
      {
        error: "execute_failed",
        message:
          err instanceof Error
            ? err.message
            : "Servicing action could not complete. Try again.",
      },
      { status: 500 }
    );
  }
}

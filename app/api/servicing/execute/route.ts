import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { hashAction, verifyAuthToken } from "@/app/lib/webauthn";
import {
  executeServicingAction,
  type ServicingActionParams,
} from "@/app/lib/servicing-executor";

/**
 * Execute a servicing action after a successful biometric authorization.
 *
 * Contract:
 *   POST /api/servicing/execute
 *   { authToken: string, action: ServicingActionParams }
 *
 * The authToken is the short-lived signed token returned by
 * /api/webauthn/authenticate/finish, bound to (email, kind, params). We
 * recompute the action hash from the incoming params and refuse to run if
 * they don't match — that prevents a token minted for "payoff Peloton" from
 * being replayed against "payoff Marriott".
 *
 * The LLM is NOT in this codepath. That's the whole point.
 */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  const name = session?.user?.name;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { authToken?: string; action?: ServicingActionParams };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body?.authToken || !body?.action || !body.action.kind) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const expectedHash = hashAction(body.action.kind, body.action);
  const verification = verifyAuthToken(body.authToken, {
    email,
    actionHash: expectedHash,
  });
  if (!verification.ok) {
    return NextResponse.json(
      { error: "auth_failed", reason: verification.reason },
      { status: 401 }
    );
  }

  const firstName = (name ?? email).split(/[\s.@]/)[0] || "there";
  try {
    const result = await executeServicingAction(body.action, {
      userEmail: email,
      firstName,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[/api/servicing/execute] executor threw:", err);
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

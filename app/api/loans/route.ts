import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DEMO_USER } from "@/app/lib/mockData";
import { buildLoanViews, type LoanOverride } from "@/app/lib/loans";

/**
 * GET /api/loans — return the active plans for the signed-in user with any
 * servicing mutations (payoff / reschedule / extra payment) folded in.
 *
 * Mutations live in the user's encrypted NextAuth JWT — see auth.ts and
 * app/lib/loans.ts. The Manage screen calls this on mount and after every
 * successful biometric authorization to refresh.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const overrides =
    (session as unknown as { loanOverrides?: LoanOverride[] }).loanOverrides ??
    [];
  const loans = buildLoanViews(DEMO_USER.activePlans, overrides);
  return NextResponse.json({
    loans,
    user: { firstName: DEMO_USER.firstName },
  });
}

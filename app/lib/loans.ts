/**
 * Per-user loan-state derivation.
 *
 * The base data lives in DEMO_USER.activePlans (server-side mock). Mutations
 * the user makes through the agent (payoff / reschedule / extra payment) are
 * recorded as LoanOverrides on the user's encrypted JWT — the same place the
 * passkey lives. There is no database in this prototype.
 *
 * The Manage screen calls /api/loans which reads the JWT, applies overrides
 * to the base data via {@link buildLoanViews}, and returns a normalized view
 * the client renders directly.
 *
 * Why JWT and not server memory: Vercel serverless functions are stateless
 * across instances, so a payoff handled by instance A wouldn't be visible to
 * a /api/loans request handled by instance B. Cookie-bound state in the user's
 * own JWT sidesteps that entirely without paying the cost of a KV/DB.
 */

import type { ActivePlan, CompletedPlan } from "./mockData";

export type LoanOverride =
  | {
      kind: "paid_off";
      loanId: string;
      refId: string;
      amount: number;
      fundingSourceLabel: string;
      at: number;
    }
  | {
      kind: "rescheduled";
      loanId: string;
      previousDueIso: string;
      newDueIso: string;
      refId: string;
      at: number;
    }
  | {
      kind: "extra_payment";
      loanId: string;
      amount: number;
      fundingSourceLabel: string;
      refId: string;
      at: number;
    };

export type LoanActivity = {
  kind: LoanOverride["kind"];
  refId: string;
  at: number;
  description: string;
};

export type LoanView = {
  id: string;
  merchant: string;
  merchantDomain: string;
  originalBalanceUsd: number;
  currentBalanceUsd: number;
  monthlyPaymentUsd: number;
  monthsRemaining: number;
  /** Empty string when the loan is paid off. */
  nextPaymentDateIso: string;
  nextPaymentLabel: string;
  status: "active" | "paid_off";
  /** ISO date the loan was paid off; empty string when still active. */
  paidOffDateIso: string;
  /** Display label for paid-off date; empty when active. */
  paidOffDateLabel: string;
  /**
   * "scheduled" → ran to term on the regular schedule.
   * "early"     → user paid off ahead of schedule.
   * undefined   → still active.
   */
  payoffMethod?: "scheduled" | "early";
  /** Term length when the plan was opened (months). */
  originalTermMonths: number;
  /** Newest first. */
  activity: LoanActivity[];
};

function isoToLabel(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function moneyShort(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function buildLoanViews(
  activePlans: ActivePlan[],
  completedPlans: CompletedPlan[],
  overrides: LoanOverride[] | undefined
): LoanView[] {
  // Sort overrides oldest -> newest so we can fold them in temporal order. The
  // activity log on each LoanView is reversed (newest first) at the end.
  const sorted = [...(overrides ?? [])].sort((a, b) => a.at - b.at);

  const activeViews: LoanView[] = activePlans.map((plan) => {
    const view: LoanView = {
      id: plan.id,
      merchant: plan.merchant,
      merchantDomain: plan.merchantDomain,
      originalBalanceUsd: plan.balance,
      currentBalanceUsd: plan.balance,
      monthlyPaymentUsd: plan.monthlyPayment,
      monthsRemaining: plan.termMonthsRemaining,
      nextPaymentDateIso: plan.nextPaymentDueISO,
      nextPaymentLabel: plan.nextPaymentDate,
      status: "active",
      paidOffDateIso: "",
      paidOffDateLabel: "",
      originalTermMonths: plan.termMonthsRemaining,
      activity: [],
    };

    for (const o of sorted) {
      if (o.loanId !== plan.id) continue;
      if (o.kind === "paid_off") {
        view.status = "paid_off";
        view.currentBalanceUsd = 0;
        view.monthsRemaining = 0;
        view.nextPaymentDateIso = "";
        view.nextPaymentLabel = "Paid in full";
        view.payoffMethod = "early";
        view.paidOffDateIso = new Date(o.at).toISOString().slice(0, 10);
        view.paidOffDateLabel = isoToLabel(view.paidOffDateIso);
        view.activity.push({
          kind: "paid_off",
          refId: o.refId,
          at: o.at,
          description: `Paid in full · ${moneyShort(o.amount)} from ${o.fundingSourceLabel}`,
        });
      } else if (o.kind === "rescheduled") {
        // No-op if loan is already paid off (defensive).
        if (view.status === "paid_off") continue;
        view.nextPaymentDateIso = o.newDueIso;
        view.nextPaymentLabel = isoToLabel(o.newDueIso);
        view.activity.push({
          kind: "rescheduled",
          refId: o.refId,
          at: o.at,
          description: `Due date moved from ${isoToLabel(o.previousDueIso)} to ${isoToLabel(o.newDueIso)}`,
        });
      } else if (o.kind === "extra_payment") {
        if (view.status === "paid_off") continue;
        view.currentBalanceUsd = Math.max(
          0,
          Math.round((view.currentBalanceUsd - o.amount) * 100) / 100
        );
        view.activity.push({
          kind: "extra_payment",
          refId: o.refId,
          at: o.at,
          description: `Extra ${moneyShort(o.amount)} payment from ${o.fundingSourceLabel}`,
        });
        // If the extra payment fully zeroed the balance, treat as paid off.
        if (view.currentBalanceUsd === 0) {
          view.status = "paid_off";
          view.monthsRemaining = 0;
          view.nextPaymentDateIso = "";
          view.nextPaymentLabel = "Paid in full";
          view.payoffMethod = "early";
          view.paidOffDateIso = new Date(o.at).toISOString().slice(0, 10);
          view.paidOffDateLabel = isoToLabel(view.paidOffDateIso);
        }
      }
    }

    view.activity.reverse();
    return view;
  });

  // Static history. Loans that closed before this account interacted with the
  // agent. They never accept overrides — the executor would have nothing to
  // do — so we render them straight through.
  const completedViews: LoanView[] = completedPlans.map((p) => ({
    id: p.id,
    merchant: p.merchant,
    merchantDomain: p.merchantDomain,
    originalBalanceUsd: p.originalAmount,
    currentBalanceUsd: 0,
    monthlyPaymentUsd: p.monthlyPayment,
    monthsRemaining: 0,
    nextPaymentDateIso: "",
    nextPaymentLabel: "Paid in full",
    status: "paid_off",
    paidOffDateIso: p.paidOffISO,
    paidOffDateLabel: isoToLabel(p.paidOffISO),
    payoffMethod: p.payoffMethod,
    originalTermMonths: p.originalTermMonths,
    activity: [],
  }));

  return [...activeViews, ...completedViews];
}

/**
 * Mock servicing / policy engine for hackathon demo.
 * Real shipping would call Affirm servicing APIs — amounts & dates are deterministic, not LLM guesses.
 */

import { DEMO_USER, RESCHEDULE_POLICY, type ActivePlan } from "./mockData";

export type FundingSource = { id: string; label: string };

export const MOCK_FUNDING_SOURCES: FundingSource[] = [
  { id: "fs_debit_442", label: "Debit ending •••442" },
  { id: "fs_bank_901", label: "Bank account ending •••901" },
];

function findLoan(loanId?: string, merchantHint?: string): ActivePlan | null {
  const plans = DEMO_USER.activePlans;
  if (loanId) {
    const p = plans.find((x) => x.id === loanId);
    if (p) return p;
  }
  if (merchantHint?.trim()) {
    const h = merchantHint.trim().toLowerCase();
    const p = plans.find((x) => x.merchant.toLowerCase().includes(h));
    if (p) return p;
  }
  return null;
}

function parseIso(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type ServicingPayoffQuoteResult =
  | {
      ok: true;
      loan_id: string;
      merchant: string;
      payoff_usd: number;
      good_through: string;
      funding_sources: FundingSource[];
      policy_note: string;
    }
  | { error: string; message: string };

/** Payoff quote: prototype uses fixed quote from mock data + cents adjustment */
export function servicingPayoffQuote(input: {
  loan_id?: string;
  merchant_hint?: string;
}): ServicingPayoffQuoteResult {
  const loan = findLoan(input.loan_id, input.merchant_hint);
  if (!loan) {
    return {
      error: "LOAN_NOT_FOUND",
      message:
        "No matching loan. Ask the user which purchase (Peloton, Nike, or Marriott) or pass loan_id.",
    };
  }
  const goodThrough = new Date();
  goodThrough.setHours(23, 59, 59, 999);
  const payoffUsd =
    typeof loan.payoffQuoteUsd === "number"
      ? loan.payoffQuoteUsd
      : Math.round((loan.balance * 1.002) * 100) / 100;

  return {
    ok: true as const,
    loan_id: loan.id,
    merchant: loan.merchant,
    payoff_usd: payoffUsd,
    good_through: goodThrough.toISOString(),
    funding_sources: MOCK_FUNDING_SOURCES,
    policy_note:
      "Quote is computed deterministically from your plan terms.",
  };
}

export type ServicingExecutePayoffResult =
  | {
      ok: true;
      status: "processing";
      reference_id: string;
      loan_id: string;
      merchant: string;
      amount_usd: number;
      funding_source_label: string;
      policy_codes: string[];
    }
  | { error: string; message: string; code?: string };

/**
 * Execute payoff. The caller (route handler) is responsible for proving the
 * user authorized this action — in production that's a biometric WebAuthn
 * assertion verified server-side; in this prototype same. The function
 * itself is deterministic and trusts that auth has already happened.
 */
export function servicingExecutePayoff(input: {
  loan_id: string;
  funding_source_id: string;
}): ServicingExecutePayoffResult {
  const loan = findLoan(input.loan_id);
  if (!loan) {
    return { error: "LOAN_NOT_FOUND", message: "Unknown loan_id." };
  }
  const fs = MOCK_FUNDING_SOURCES.find((f) => f.id === input.funding_source_id);
  if (!fs) {
    return {
      error: "INVALID_FUNDING",
      message: `Unknown funding_source_id. Use one of: ${MOCK_FUNDING_SOURCES.map((f) => f.id).join(", ")}`,
    };
  }
  const q = servicingPayoffQuote({ loan_id: loan.id });
  if ("error" in q) return q;
  const payoffUsd = q.payoff_usd;
  const ref = `APY-${Date.now().toString(36).toUpperCase().slice(-8)}`;
  return {
    ok: true as const,
    status: "processing" as const,
    reference_id: ref,
    loan_id: loan.id,
    merchant: loan.merchant,
    amount_usd: payoffUsd,
    funding_source_label: fs.label,
    policy_codes: ["PAYOFF_OK"],
  };
}

export type ServicingReschedulePreviewResult =
  | {
      ok: true;
      loan_id: string;
      merchant: string;
      current_due_iso: string;
      current_due_label: string;
      next_installment_usd: number;
      allowed_reschedule_targets: { iso: string; label: string }[];
      blocked_request: { code: string; message: string; latest_eligible_iso: string } | null;
      requested_date_iso: string | null;
      requested_date_label: string | null;
      /**
       * Outcome of THIS specific request:
       *   "approved" — user named a date, policy engine approved it
       *   "blocked"  — user named a date, policy engine rejected it (see blocked_request)
       *   null       — user didn't name a date; this is a generic "show me options" preview
       * The UI uses this to decide whether to show the green Eligible badge.
       */
      request_outcome: "approved" | "blocked" | null;
      policy_note: string;
    }
  | { error: string; message: string };

/** List discrete allowed reschedule targets within max slip from current due */
export function servicingReschedulePreview(input: {
  loan_id?: string;
  merchant_hint?: string;
  requested_date_iso?: string;
}): ServicingReschedulePreviewResult {
  const loan = findLoan(input.loan_id, input.merchant_hint);
  if (!loan) {
    return {
      error: "LOAN_NOT_FOUND",
      message:
        "No matching loan. Clarify Peloton, Nike, or Marriott — or pass loan_id.",
    };
  }

  const due = parseIso(loan.nextPaymentDueISO);
  if (!due) {
    return { error: "DATA", message: "Loan missing nextPaymentDueISO." };
  }

  const maxSlipDays = loan.rescheduleMaxDaysFromDue ?? RESCHEDULE_POLICY.windowDays;
  const used = loan.reschedulesUsedThisCycle ?? 0;
  const cycleLimitHit = used >= RESCHEDULE_POLICY.maxPerCycle;

  const latest = new Date(due);
  latest.setUTCDate(latest.getUTCDate() + maxSlipDays);

  const requested = input.requested_date_iso
    ? parseIso(input.requested_date_iso)
    : null;

  // If the user has already used their reschedule this cycle, no targets are
  // valid regardless of date — surface an empty target list so the UI never
  // shows pickable dates the policy engine would reject.
  const allowed: { iso: string; label: string }[] = [];
  const labelForDate = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  if (!cycleLimitHit) {
    const seen = new Set<string>();
    const pushDay = (offset: number) => {
      const d = new Date(due);
      d.setUTCDate(d.getUTCDate() + offset);
      if (d > latest) return;
      const iso = d.toISOString().slice(0, 10);
      if (seen.has(iso)) return;
      seen.add(iso);
      allowed.push({ iso, label: labelForDate(d) });
    };
    [2, 3, 5, 7, 10, 14].forEach(pushDay);
    // If the user asked for a specific date that's within window, make sure
    // it's a chip option and pre-selectable on the card.
    if (requested && requested <= latest && requested >= due) {
      const reqIso = requested.toISOString().slice(0, 10);
      if (!seen.has(reqIso)) {
        allowed.push({ iso: reqIso, label: labelForDate(requested) });
        allowed.sort((a, b) => a.iso.localeCompare(b.iso));
      }
    }
  }

  let blocked: {
    code: string;
    message: string;
    latest_eligible_iso: string;
  } | null = null;

  // Cycle-limit denial takes precedence — it applies regardless of requested date.
  if (cycleLimitHit) {
    blocked = {
      code: "RSH-CYCLE_LIMIT",
      message: `${loan.merchant} has already been rescheduled ${used} time${used === 1 ? "" : "s"} this billing cycle. Plan policy allows ${RESCHEDULE_POLICY.maxPerCycle} reschedule per cycle.`,
      latest_eligible_iso: latest.toISOString().slice(0, 10),
    };
  } else if (requested && requested > latest) {
    const dayDiff = Math.round((requested.getTime() - due.getTime()) / 86_400_000);
    blocked = {
      code: "RSH-MAX_WINDOW",
      message: `${loan.merchant} plan allows reschedule up to ${maxSlipDays} days past the original due date. You asked for ${dayDiff} days. Latest eligible is ${latest.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.`,
      latest_eligible_iso: latest.toISOString().slice(0, 10),
    };
  } else if (requested && requested < due) {
    // Earlier-than-due reschedule isn't an error — the user just picked a date
    // before their current due. Surface as a soft block so the card shows the
    // eligible alternatives instead of incorrectly badging the request approved.
    blocked = {
      code: "RSH-PAST",
      message: `${labelForDate(requested)} is before your current ${loan.merchant} due date of ${due.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}. Pick one of the eligible dates below — or use Pay early to clear this installment now.`,
      latest_eligible_iso: latest.toISOString().slice(0, 10),
    };
  }

  const requestOutcome: "approved" | "blocked" | null = requested
    ? blocked
      ? "blocked"
      : "approved"
    : null;

  return {
    ok: true as const,
    loan_id: loan.id,
    merchant: loan.merchant,
    current_due_iso: due.toISOString().slice(0, 10),
    current_due_label: due.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
    next_installment_usd: loan.monthlyPayment,
    allowed_reschedule_targets: allowed,
    blocked_request: blocked,
    requested_date_iso: input.requested_date_iso ?? null,
    requested_date_label: requested
      ? requested.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })
      : null,
    request_outcome: requestOutcome,
    policy_note: `Reschedule allowed up to ${maxSlipDays} days past due, ${RESCHEDULE_POLICY.maxPerCycle} per billing cycle.`,
  };
}

export type ServicingExecuteRescheduleResult =
  | {
      ok: true;
      status: "confirmed";
      reference_id: string;
      loan_id: string;
      merchant: string;
      previous_due_iso: string;
      new_due_iso: string;
      next_installment_usd: number;
      policy_codes: string[];
    }
  | { error: string; message: string; code?: string };

export function servicingExecuteReschedule(input: {
  loan_id: string;
  new_date_iso: string;
}): ServicingExecuteRescheduleResult {
  const loan = findLoan(input.loan_id);
  if (!loan) {
    return { error: "LOAN_NOT_FOUND", message: "Unknown loan." };
  }

  const due = parseIso(loan.nextPaymentDueISO);
  if (!due) return { error: "DATA", message: "Missing nextPaymentDueISO." };

  const target = parseIso(input.new_date_iso);
  if (!target) {
    return { error: "BAD_DATE", message: "Invalid new_date_iso (use YYYY-MM-DD)." };
  }

  const used = loan.reschedulesUsedThisCycle ?? 0;
  if (used >= RESCHEDULE_POLICY.maxPerCycle) {
    return {
      error: "RSH-CYCLE_LIMIT",
      message: `${loan.merchant} has already been rescheduled this billing cycle.`,
      code: "RSH-CYCLE_LIMIT",
    };
  }

  const maxSlipDays = loan.rescheduleMaxDaysFromDue ?? RESCHEDULE_POLICY.windowDays;
  const maxDate = new Date(due);
  maxDate.setUTCDate(maxDate.getUTCDate() + maxSlipDays);

  if (target > maxDate) {
    return {
      error: "RSH-MAX_WINDOW",
      message: `Latest eligible date is ${maxDate.toISOString().slice(0, 10)}.`,
      code: "RSH-MAX_WINDOW",
    };
  }
  if (target < due) {
    return {
      error: "RSH-PAST",
      message: "Target date can't be before current due.",
    };
  }

  const ref = `RSH-${Date.now().toString(36).toUpperCase().slice(-8)}`;
  return {
    ok: true as const,
    status: "confirmed" as const,
    reference_id: ref,
    loan_id: loan.id,
    merchant: loan.merchant,
    previous_due_iso: due.toISOString().slice(0, 10),
    new_due_iso: input.new_date_iso,
    next_installment_usd: loan.monthlyPayment,
    policy_codes: ["RESCHEDULE_OK"],
  };
}

export type ServicingPayInstallmentResult =
  | {
      ok: true;
      status: "processing";
      reference_id: string;
      loan_id: string;
      merchant: string;
      amount_usd: number;
      funding_source_label: string;
      note: string;
    }
  | { error: string; message: string };

/** Extra payment toward next installment (script C pivot) */
export function servicingPayInstallment(input: {
  loan_id: string;
  amount_usd: number;
  funding_source_id: string;
}): ServicingPayInstallmentResult {
  const loan = findLoan(input.loan_id);
  if (!loan) return { error: "LOAN_NOT_FOUND", message: "Unknown loan." };
  const fs = MOCK_FUNDING_SOURCES.find((f) => f.id === input.funding_source_id);
  if (!fs) return { error: "INVALID_FUNDING", message: "Bad funding_source_id." };
  const ref = `APY-${Date.now().toString(36).toUpperCase().slice(-8)}`;
  return {
    ok: true as const,
    status: "processing" as const,
    reference_id: ref,
    loan_id: loan.id,
    merchant: loan.merchant,
    amount_usd: Math.round(input.amount_usd * 100) / 100,
    funding_source_label: fs.label,
    note: "Applied toward your next installment once it posts.",
  };
}

// ---------------------------------------------------------------------------
// Refund case opening (handoff to merchant)
// ---------------------------------------------------------------------------

export type ServicingRefundCaseResult =
  | {
      ok: true;
      case_id: string;
      loan_id: string;
      merchant: string;
      merchant_domain: string;
      product_title: string;
      purchased_label: string;
      purchased_iso: string;
      original_amount_usd: number;
      remaining_balance_usd: number;
      monthly_payment_usd: number;
      next_due_label: string;
      autopay_paused_until_label: string;
      contact_url: string;
      contact_label: string;
    }
  | { error: string; message: string };

/**
 * Open a refund case. Affirm doesn't issue refunds itself — the merchant does.
 * What we DO own is the loan: we pause autopay while the merchant works on it,
 * and adjust the principal once the refund clears.
 *
 * Returns a structured case the UI renders as a "what happens next" card with
 * a one-tap deep-link to the merchant. Pure read; no auth needed.
 */
export function servicingOpenRefundCase(input: {
  loan_id?: string;
  merchant_hint?: string;
}): ServicingRefundCaseResult {
  const loan = findLoan(input.loan_id, input.merchant_hint);
  if (!loan) {
    return {
      error: "LOAN_NOT_FOUND",
      message:
        "No matching loan to refund. Tell me which purchase — Peloton, Nike, or Marriott.",
    };
  }
  if (!loan.purchase) {
    return {
      error: "NO_PURCHASE_CONTEXT",
      message: "Refund context isn't available for this loan.",
    };
  }
  const caseId = `RFD-${Date.now().toString(36).toUpperCase().slice(-8)}`;
  const pauseUntil = new Date(`${loan.nextPaymentDueISO}T00:00:00Z`);
  pauseUntil.setUTCDate(pauseUntil.getUTCDate() + 30);
  return {
    ok: true as const,
    case_id: caseId,
    loan_id: loan.id,
    merchant: loan.merchant,
    merchant_domain: loan.merchantDomain,
    product_title: loan.purchase.productTitle,
    purchased_label: loan.purchase.purchasedLabel,
    purchased_iso: loan.purchase.purchasedISO,
    original_amount_usd:
      loan.balance + loan.monthlyPayment * (12 - loan.termMonthsRemaining),
    remaining_balance_usd: loan.balance,
    monthly_payment_usd: loan.monthlyPayment,
    next_due_label: loan.nextPaymentDate,
    autopay_paused_until_label: pauseUntil.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
    contact_url: `https://www.${loan.merchantDomain}/help`,
    contact_label: `Contact ${loan.merchant}`,
  };
}

export type TriagePlanRow = {
  loan_id: string;
  merchant: string;
  merchant_domain: string;
  next_due_iso: string;
  next_due_label: string;
  days_until_due: number;
  monthly_payment_usd: number;
  reschedule_eligible: boolean;
  /** Set when reschedule_eligible === false. Examples: RSH-CYCLE_LIMIT. */
  reschedule_block_code?: string;
  reschedule_block_reason?: string;
  /** Latest eligible date (inclusive) if reschedule is allowed. */
  latest_eligible_iso?: string;
  latest_eligible_label?: string;
};

export type ServicingTriageResult =
  | {
      ok: true;
      total_due_window_usd: number;
      window_label: string;
      plans: TriagePlanRow[];
      recommended:
        | {
            kind: "reschedule";
            loan_id: string;
            merchant: string;
            monthly_payment_usd: number;
            current_due_label: string;
            latest_eligible_label: string;
            rationale: string;
          }
        | {
            kind: "pay_early";
            loan_id: string;
            merchant: string;
            monthly_payment_usd: number;
            current_due_label: string;
            rationale: string;
          }
        | null;
      policy_note: string;
    }
  | { error: string; message: string };

/**
 * Cross-plan cash-flow triage. Returns every active plan sorted by next due
 * date with a per-plan reschedule eligibility check, plus a recommended
 * action picked deterministically:
 *
 *   1. If any plan is reschedule-eligible, recommend rescheduling the one
 *      with the SOONEST due date (that's the one that frees the most cash
 *      the fastest).
 *   2. If no plan is reschedule-eligible (e.g. every loan already used its
 *      reschedule this cycle), fall back to "pay early on the soonest one"
 *      so the user still has an actionable next step.
 *   3. If the user has no active plans, return a clean error.
 *
 * Why this exists: the Manage tab can show every loan, but it can't reason
 * across them — it doesn't know "Nike's already used this cycle, Peloton
 * isn't, Peloton's due first" and decide for the user. That's the agent's
 * job, and it's the entire reason the cross-plan card needs to exist.
 *
 * The recommendation is deterministic so the LLM can't override it. The
 * agent's job is to phrase it; the engine decides which plan.
 */
export function servicingTriageOptions(_input: {
  /** Free-text constraint label for telemetry; doesn't change the math. */
  constraint?: string;
}): ServicingTriageResult {
  const plans = DEMO_USER.activePlans;
  if (plans.length === 0) {
    return { error: "NO_PLANS", message: "No active plans on this account." };
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const labelForDate = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });

  const rows: TriagePlanRow[] = plans
    .map((p) => {
      const due = parseIso(p.nextPaymentDueISO);
      if (!due) return null;
      const daysUntil = Math.round(
        (due.getTime() - today.getTime()) / 86_400_000
      );
      const used = p.reschedulesUsedThisCycle ?? 0;
      const cycleLimitHit = used >= RESCHEDULE_POLICY.maxPerCycle;
      const maxSlipDays = p.rescheduleMaxDaysFromDue ?? RESCHEDULE_POLICY.windowDays;
      const latest = new Date(due);
      latest.setUTCDate(latest.getUTCDate() + maxSlipDays);

      const row: TriagePlanRow = {
        loan_id: p.id,
        merchant: p.merchant,
        merchant_domain: p.merchantDomain,
        next_due_iso: p.nextPaymentDueISO,
        next_due_label: labelForDate(due),
        days_until_due: daysUntil,
        monthly_payment_usd: p.monthlyPayment,
        reschedule_eligible: !cycleLimitHit,
      };
      if (cycleLimitHit) {
        row.reschedule_block_code = "RSH-CYCLE_LIMIT";
        row.reschedule_block_reason = `Already rescheduled ${used} time${used === 1 ? "" : "s"} this billing cycle.`;
      } else {
        row.latest_eligible_iso = latest.toISOString().slice(0, 10);
        row.latest_eligible_label = labelForDate(latest);
      }
      return row;
    })
    .filter((r): r is TriagePlanRow => r !== null)
    .sort((a, b) => a.next_due_iso.localeCompare(b.next_due_iso));

  const totalDueUsd = rows.reduce((s, r) => s + r.monthly_payment_usd, 0);
  const horizonDays = rows.length > 0 ? rows[rows.length - 1].days_until_due : 0;
  const windowLabel =
    horizonDays <= 7
      ? "Next 7 days"
      : horizonDays <= 14
      ? "Next 2 weeks"
      : horizonDays <= 30
      ? "Next 30 days"
      : "Upcoming";

  const eligibleRows = rows.filter((r) => r.reschedule_eligible);
  type Recommendation = Exclude<
    Extract<ServicingTriageResult, { ok: true }>["recommended"],
    null
  >;
  let recommended: Recommendation;
  if (eligibleRows.length > 0) {
    const best = eligibleRows[0]; // already sorted by soonest due
    recommended = {
      kind: "reschedule",
      loan_id: best.loan_id,
      merchant: best.merchant,
      monthly_payment_usd: best.monthly_payment_usd,
      current_due_label: best.next_due_label,
      latest_eligible_label: best.latest_eligible_label!,
      rationale: `${best.merchant} is your soonest reschedule-eligible payment. Moving it buys you the most time without burning a cycle on a plan that still has options.`,
    };
  } else {
    const fallback = rows[0];
    recommended = {
      kind: "pay_early",
      loan_id: fallback.loan_id,
      merchant: fallback.merchant,
      monthly_payment_usd: fallback.monthly_payment_usd,
      current_due_label: fallback.next_due_label,
      rationale: `Every plan has already used its reschedule this cycle, so a reschedule isn't on the table. Paying ${fallback.merchant} early is the cleanest way to take that one off the board.`,
    };
  }

  return {
    ok: true as const,
    total_due_window_usd: Math.round(totalDueUsd * 100) / 100,
    window_label: windowLabel,
    plans: rows,
    recommended,
    policy_note: `Reschedule allowed up to ${RESCHEDULE_POLICY.windowDays} days past due, ${RESCHEDULE_POLICY.maxPerCycle} per billing cycle.`,
  };
}

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

  // Cycle-limit denial takes precedence — it applies regardless of requested
  // date. Message phrasing is deliberately routed-not-denied: this is a
  // SELF-SERVE channel limit, not a credit decision. A human servicing rep
  // can still make the change. See the regulatory framing in /about.
  if (cycleLimitHit) {
    blocked = {
      code: "RSH-CYCLE_LIMIT",
      message: `${loan.merchant}'s next payment has already been moved once. Self-serve allows ${RESCHEDULE_POLICY.maxPerCycle} reschedule per upcoming payment — additional changes need a servicing rep.`,
      latest_eligible_iso: latest.toISOString().slice(0, 10),
    };
  } else if (requested && requested > latest) {
    const dayDiff = Math.round((requested.getTime() - due.getTime()) / 86_400_000);
    blocked = {
      code: "RSH-MAX_WINDOW",
      message: `Self-serve reschedule is limited to ${maxSlipDays} days past the original due date. You asked for ${dayDiff} days. Latest self-serve eligible is ${latest.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}. Beyond that, a servicing rep can help.`,
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
    policy_note: `Reschedule allowed up to ${maxSlipDays} days past due. Each upcoming payment can be moved once before requiring a servicing rep.`,
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
      message: `${loan.merchant}'s next payment has already been moved once.`,
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
  /**
   * Plan APR in basis points. Surfaced on triage rows so the user can see
   * "moving Marriott costs more to carry than moving Nike" at a glance — it's
   * one of the inputs to the recommendation but the user gets to see the
   * data the engine used.
   */
  apr_bps: number;
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
        apr_bps: p.aprBps,
        reschedule_eligible: !cycleLimitHit,
      };
      if (cycleLimitHit) {
        row.reschedule_block_code = "RSH-CYCLE_LIMIT";
        row.reschedule_block_reason = `This upcoming payment has already been moved ${used} time${used === 1 ? "" : "s"}. Self-serve allows one reschedule per payment.`;
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
      rationale: `Every upcoming payment has already been moved once, so reschedule isn't on the table. Paying ${fallback.merchant} early is the cleanest way to take that one off the board.`,
    };
  }

  return {
    ok: true as const,
    total_due_window_usd: Math.round(totalDueUsd * 100) / 100,
    window_label: windowLabel,
    plans: rows,
    recommended,
    policy_note: `Reschedule allowed up to ${RESCHEDULE_POLICY.windowDays} days past due. Each upcoming payment can be moved once before requiring a servicing rep.`,
  };
}

// ---------------------------------------------------------------------------
// Cross-plan optimization (extra-cash allocation)
// ---------------------------------------------------------------------------

export type OptimizationStrategy =
  | "save_interest"
  | "clear_plan"
  | "free_cash_flow"
  | "allocate_across";

/**
 * One leg of a multi-plan allocation. Each leg is independently authorized
 * (single-plan WebAuthn assertion). The card sequences them — there's no
 * "bulk authorize" path on purpose. We preserve per-action audit + the
 * existing executor surface.
 */
export type AllocationLeg = {
  loan_id: string;
  merchant: string;
  merchant_domain: string;
  apply_amount_usd: number;
  closes_plan: boolean;
  apr_bps: number;
};

export type OptimizationOption = {
  /** 1-indexed rank within the result set. The recommended option is rank 1. */
  rank: number;
  strategy: OptimizationStrategy;
  loan_id: string;
  merchant: string;
  merchant_domain: string;
  apr_bps: number;
  /** Dollars actually applied to this loan (≤ amount_usd, ≤ balance). */
  apply_amount_usd: number;
  /** Money left over from amount_usd after applying. Useful when a plan is fully cleared. */
  leftover_usd: number;
  remaining_balance_after_usd: number;
  /** True if this option fully closes the plan. */
  closes_plan: boolean;
  /**
   * Estimated interest saved vs continuing to pay normally.
   *   est_interest_saved = apply_amount * apr * remaining_term_years * 0.5
   * The 0.5 captures the "money applied today reduces the AVERAGE balance
   * over the remaining term, not the full balance" intuition. Approximate;
   * good enough to rank options. Always 0 for 0% APR plans.
   */
  est_interest_saved_usd: number;
  /**
   * Estimated months knocked off the original term:
   *   floor(apply_amount / monthly_payment)
   * Conservative — ignores compounding amortization effects.
   */
  est_months_saved: number;
  headline: string;
  rationale: string;
  /**
   * Set ONLY when strategy === "allocate_across". When present, the UI
   * renders a multi-leg breakdown and replaces the single-plan CTA with
   * one button per leg. The single-plan fields above (loan_id, merchant,
   * apr_bps, etc.) reflect the FIRST leg as an anchor for legacy code
   * paths; UI consumers should branch on allocation_legs instead.
   */
  allocation_legs?: AllocationLeg[];
  /** Number of plans this option fully closes. Convenience for the card. */
  plans_closed_count?: number;
};

export type ServicingOptimizationResult =
  | {
      ok: true;
      hypothetical_amount_usd: number;
      options: OptimizationOption[];
      policy_note: string;
    }
  | { error: string; message: string };

/** Default amount when the user is vague ("where should I put extra cash?"). */
const DEFAULT_OPTIMIZATION_AMOUNT_USD = 500;

/**
 * Cross-plan extra-cash optimizer. Given a hypothetical extra dollar amount,
 * returns up to four ranked allocation options — each driven by a DIFFERENT
 * goal the user might have:
 *
 *   1. allocate_across (CONDITIONAL): split the cash across multiple plans
 *      to close 2+ plans in one move + apply leftover to the highest-APR
 *      plan still standing. Only surfaced when the budget can fully close
 *      at least two plans (greedy by smallest balance) — otherwise it
 *      collapses to clear_plan and we'd rather not show a redundant row.
 *      When present, this becomes rank 1 because closing multiple plans
 *      dominates any single-plan move on stated user goal ("deploy this
 *      cash optimally"). It's the answer Manage absolutely cannot give.
 *
 *   2. save_interest: maximize $ saved on interest. Picks the highest-APR
 *      plan and applies as much as possible. Economically optimal answer
 *      for a single-plan move.
 *
 *   3. clear_plan: knock a plan off the board entirely. Picks the smallest
 *      plan that fits within amount_usd. Psychologically the move most
 *      users actually make (debt-snowball preference).
 *
 *   4. free_cash_flow: reduce near-term cash burden. Picks the plan that's
 *      due soonest and applies as many monthly payments as the amount can
 *      cover. Best when the user is cash-tight in the next 1-2 weeks.
 *
 * Why this exists at all: this is the canonical decision the Manage tab
 * cannot perform. Manage shows balances, dates, and APRs separately. It
 * cannot rank "where should I put $500" because the right answer depends
 * on the user's goal — and only the agent can ask one sentence to figure
 * out which goal applies. The card surfaces all options so the user picks
 * with full visibility into the trade-off.
 *
 * The math is intentionally simple. Real shipping would route through the
 * existing servicing payoff/installment APIs and use canonical amortization
 * schedules; the demo's job is to show the reasoning shape, not the
 * accounting precision.
 */
export function servicingOptimizationOptions(input: {
  amount_usd?: number;
}): ServicingOptimizationResult {
  const plans = DEMO_USER.activePlans;
  if (plans.length === 0) {
    return { error: "NO_PLANS", message: "No active plans on this account." };
  }

  const amount = Math.max(
    1,
    Math.round((input.amount_usd ?? DEFAULT_OPTIMIZATION_AMOUNT_USD) * 100) / 100
  );

  type PlanLite = {
    id: string;
    merchant: string;
    merchant_domain: string;
    balance: number;
    monthly: number;
    months_remaining: number;
    apr_bps: number;
    next_due_iso: string;
  };

  const lite: PlanLite[] = plans.map((p) => ({
    id: p.id,
    merchant: p.merchant,
    merchant_domain: p.merchantDomain,
    balance: p.balance,
    monthly: p.monthlyPayment,
    months_remaining: p.termMonthsRemaining,
    apr_bps: p.aprBps,
    next_due_iso: p.nextPaymentDueISO,
  }));

  // Strategy 1: save the most on interest → highest APR (ties → larger balance).
  const interestRanked = [...lite].sort((a, b) => {
    if (b.apr_bps !== a.apr_bps) return b.apr_bps - a.apr_bps;
    return b.balance - a.balance;
  });

  // Strategy 2: clear a plan entirely. Prefer the smallest plan whose balance
  // fits inside `amount`. If none fits, fall back to "smallest plan" so the
  // user gets the closest-to-clearing option.
  const closableSorted = [...lite]
    .filter((p) => p.balance <= amount)
    .sort((a, b) => a.balance - b.balance);
  const clearTarget =
    closableSorted[0] ?? [...lite].sort((a, b) => a.balance - b.balance)[0];

  // Strategy 3: free near-term cash → soonest due (ties → larger monthly).
  const cashFlowRanked = [...lite].sort((a, b) => {
    if (a.next_due_iso !== b.next_due_iso)
      return a.next_due_iso.localeCompare(b.next_due_iso);
    return b.monthly - a.monthly;
  });

  const buildOption = (
    strategy: OptimizationStrategy,
    target: PlanLite
  ): Omit<OptimizationOption, "rank" | "headline" | "rationale"> => {
    const apply = Math.min(amount, target.balance);
    const remaining = Math.max(0, Math.round((target.balance - apply) * 100) / 100);
    const closes = remaining === 0;
    const aprDecimal = target.apr_bps / 10000;
    const yearsRemaining = target.months_remaining / 12;
    const interestSaved =
      target.apr_bps > 0
        ? Math.round(apply * aprDecimal * yearsRemaining * 0.5 * 100) / 100
        : 0;
    const monthsSaved = Math.floor(apply / target.monthly);
    return {
      strategy,
      loan_id: target.id,
      merchant: target.merchant,
      merchant_domain: target.merchant_domain,
      apr_bps: target.apr_bps,
      apply_amount_usd: Math.round(apply * 100) / 100,
      leftover_usd: Math.round((amount - apply) * 100) / 100,
      remaining_balance_after_usd: remaining,
      closes_plan: closes,
      est_interest_saved_usd: interestSaved,
      est_months_saved: monthsSaved,
    };
  };

  const aprPctLabel = (bps: number) =>
    bps === 0 ? "0% APR" : `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}% APR`;
  const moneyShort = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  // Strategy 1 framing
  const interestTarget = interestRanked[0];
  const interestPart = buildOption("save_interest", interestTarget);
  const interestOption: OptimizationOption = {
    ...interestPart,
    rank: 0,
    headline:
      interestTarget.apr_bps > 0
        ? `Save ~${moneyShort(interestPart.est_interest_saved_usd)} in interest on ${interestTarget.merchant}`
        : `${interestTarget.merchant} is your largest balance`,
    rationale:
      interestTarget.apr_bps > 0
        ? `${interestTarget.merchant} is at ${aprPctLabel(interestTarget.apr_bps)} — your most expensive plan. Putting ${moneyShort(interestPart.apply_amount_usd)} against principal cuts the average balance carrying interest, saving roughly ${moneyShort(interestPart.est_interest_saved_usd)} over the remaining ${interestTarget.months_remaining} months.`
        : `Every active plan is at 0% APR or below ${aprPctLabel(interestTarget.apr_bps)}, so there's no interest to save here. ${interestTarget.merchant} has the largest principal, so it's the biggest balance reduction.`,
  };

  // Strategy 2 framing
  const clearPart = buildOption("clear_plan", clearTarget);
  const clearOption: OptimizationOption = {
    ...clearPart,
    rank: 0,
    headline: clearPart.closes_plan
      ? `Close ${clearTarget.merchant} today`
      : `Knock down ${clearTarget.merchant} the most`,
    rationale: clearPart.closes_plan
      ? `${moneyShort(clearPart.apply_amount_usd)} fully clears ${clearTarget.merchant}. One fewer plan on your account, ${moneyShort(clearTarget.monthly)}/mo back in your budget, and ${moneyShort(clearPart.leftover_usd)} left to apply elsewhere.`
      : `${clearTarget.merchant} has the smallest balance left (${moneyShort(clearTarget.balance)}). Putting ${moneyShort(clearPart.apply_amount_usd)} against it cuts ~${clearPart.est_months_saved} months off and gets you closest to closing it.`,
  };

  // Strategy 3 framing
  const cashTarget = cashFlowRanked[0];
  const cashPart = buildOption("free_cash_flow", cashTarget);
  const cashOption: OptimizationOption = {
    ...cashPart,
    rank: 0,
    headline: `Cover the next ${cashPart.est_months_saved} ${cashTarget.merchant} payment${cashPart.est_months_saved === 1 ? "" : "s"}`,
    rationale: `${cashTarget.merchant} is your soonest payment (${moneyShort(cashTarget.monthly)} due ${labelForIso(cashTarget.next_due_iso)}). Applying ${moneyShort(cashPart.apply_amount_usd)} covers ~${cashPart.est_months_saved} upcoming installment${cashPart.est_months_saved === 1 ? "" : "s"}, which is the fastest way to give yourself breathing room next week.`,
  };

  // Allocation strategy: greedy-close smallest plans first; apply remainder
  // to the highest-APR remaining plan. Only surface the option when it
  // closes 2+ plans — otherwise it's redundant with clear_plan and we'd
  // be padding the card.
  const sortedAsc = [...lite].sort((a, b) => a.balance - b.balance);
  const closingLegs: AllocationLeg[] = [];
  let remaining = amount;
  const closedIds = new Set<string>();
  for (const p of sortedAsc) {
    if (remaining < p.balance) break;
    closingLegs.push({
      loan_id: p.id,
      merchant: p.merchant,
      merchant_domain: p.merchant_domain,
      apply_amount_usd: Math.round(p.balance * 100) / 100,
      closes_plan: true,
      apr_bps: p.apr_bps,
    });
    closedIds.add(p.id);
    remaining = Math.round((remaining - p.balance) * 100) / 100;
  }

  // If we have leftover and at least one plan we didn't close, tail-apply it
  // to the highest-APR remaining plan (most interest savings per dollar).
  let tailLeg: AllocationLeg | null = null;
  if (closingLegs.length >= 2 && remaining > 0.005) {
    const remainingPlans = lite.filter((p) => !closedIds.has(p.id));
    remainingPlans.sort((a, b) => {
      if (b.apr_bps !== a.apr_bps) return b.apr_bps - a.apr_bps;
      return b.balance - a.balance;
    });
    const target = remainingPlans[0];
    if (target) {
      const apply = Math.min(remaining, target.balance);
      tailLeg = {
        loan_id: target.id,
        merchant: target.merchant,
        merchant_domain: target.merchant_domain,
        apply_amount_usd: Math.round(apply * 100) / 100,
        closes_plan: apply >= target.balance,
        apr_bps: target.apr_bps,
      };
    }
  }

  const allocationLegs: AllocationLeg[] = tailLeg
    ? [...closingLegs, tailLeg]
    : closingLegs;

  // Estimate combined interest saved across all legs of the allocation.
  const allocInterestSaved = allocationLegs.reduce((sum, leg) => {
    const plan = lite.find((p) => p.id === leg.loan_id);
    if (!plan || plan.apr_bps === 0) return sum;
    const yearsRemaining = plan.months_remaining / 12;
    const apr = plan.apr_bps / 10000;
    return sum + leg.apply_amount_usd * apr * yearsRemaining * 0.5;
  }, 0);

  let allocOption: OptimizationOption | null = null;
  if (closingLegs.length >= 2) {
    const closesCount = allocationLegs.filter((l) => l.closes_plan).length;
    const closedNames = closingLegs.map((l) => l.merchant).join(" and ");
    const tailFragment = tailLeg
      ? `, then puts ${moneyShort(tailLeg.apply_amount_usd)} against ${tailLeg.merchant} at ${aprPctLabel(tailLeg.apr_bps)}`
      : "";
    const totalApplied = allocationLegs.reduce(
      (s, l) => s + l.apply_amount_usd,
      0
    );
    const leftover = Math.round((amount - totalApplied) * 100) / 100;
    const headline = `Close ${closesCount} plan${closesCount === 1 ? "" : "s"} in one move`;
    // Rationale stays short on purpose — the leg breakdown below shows
    // the math; the prose is just the one-line strategy framing.
    const rationale = `Closes ${closedNames} outright${tailFragment}.`;
    const anchor = closingLegs[0];
    allocOption = {
      rank: 0,
      strategy: "allocate_across",
      loan_id: anchor.loan_id,
      merchant: anchor.merchant,
      merchant_domain: anchor.merchant_domain,
      apr_bps: anchor.apr_bps,
      apply_amount_usd: Math.round(totalApplied * 100) / 100,
      leftover_usd: Math.max(0, leftover),
      remaining_balance_after_usd: 0,
      closes_plan: false, // closes_plan is per-leg; UI uses plans_closed_count
      est_interest_saved_usd: Math.round(allocInterestSaved * 100) / 100,
      est_months_saved: 0,
      headline,
      rationale,
      allocation_legs: allocationLegs,
      plans_closed_count: closesCount,
    };
  }

  // Order: when an allocation option exists it leads — closing 2+ plans
  // beats any single-plan move on most users' stated goals. Otherwise
  // fall back to the original (save_interest, clear_plan, free_cash_flow).
  const baseOrdered = allocOption
    ? [allocOption, interestOption, clearOption, cashOption]
    : [interestOption, clearOption, cashOption];
  const ordered = baseOrdered.map((o, i) => ({ ...o, rank: i + 1 }));

  return {
    ok: true as const,
    hypothetical_amount_usd: amount,
    options: ordered,
    policy_note:
      "Each option applies to principal and is reversible until you tap Confirm with Face ID. Estimates are approximate; the executor will surface exact numbers before you authorize.",
  };
}

function labelForIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

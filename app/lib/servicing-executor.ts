/**
 * Deterministic servicing executor.
 *
 * Called by /api/servicing/execute AFTER a successful biometric authorization
 * (verified WebAuthn assertion). The LLM never reaches this code path —
 * that's the point. The agent identifies intent and calls quote/preview;
 * the user authorizes via Touch ID/Face ID; this executor runs the action
 * deterministically against mock servicing data and dispatches the receipt
 * email.
 */

import {
  servicingExecutePayoff,
  servicingExecuteReschedule,
  servicingPayInstallment,
  type ServicingExecutePayoffResult,
  type ServicingExecuteRescheduleResult,
  type ServicingPayInstallmentResult,
} from "./servicing";
import {
  sendPayInstallmentEmail,
  sendPayoffEmail,
  sendRescheduleEmail,
  type SendServicingEmailResult,
} from "./email";

export type ServicingActionKind = "payoff" | "reschedule" | "pay_installment";

export type ServicingActionParams =
  | { kind: "payoff"; loan_id: string; funding_source_id: string }
  | { kind: "reschedule"; loan_id: string; new_date_iso: string }
  | {
      kind: "pay_installment";
      loan_id: string;
      amount_usd: number;
      funding_source_id: string;
    };

export type ServicingEmailStatus = {
  status: "sent" | "skipped" | "error";
  to: string;
  message?: string;
};

export type ServicingActionResult =
  | (ServicingExecutePayoffResult & {
      kind: "payoff";
      email?: ServicingEmailStatus;
    })
  | (ServicingExecuteRescheduleResult & {
      kind: "reschedule";
      email?: ServicingEmailStatus;
    })
  | (ServicingPayInstallmentResult & {
      kind: "pay_installment";
      email?: ServicingEmailStatus;
    });

function summarizeEmail(
  result: SendServicingEmailResult,
  to: string
): ServicingEmailStatus {
  if (result.sent) return { status: "sent", to };
  if (result.skipped) return { status: "skipped", to, message: result.reason };
  return { status: "error", to, message: result.error };
}

export async function executeServicingAction(
  action: ServicingActionParams,
  context: { userEmail: string; firstName: string }
): Promise<ServicingActionResult> {
  if (action.kind === "payoff") {
    const result = servicingExecutePayoff({
      loan_id: action.loan_id,
      funding_source_id: action.funding_source_id,
    });
    if ("ok" in result && result.ok) {
      const email = await sendPayoffEmail({
        to: context.userEmail,
        firstName: context.firstName,
        merchant: result.merchant,
        amountUsd: result.amount_usd,
        fundingSourceLabel: result.funding_source_label,
        referenceId: result.reference_id,
      });
      return { kind: "payoff", ...result, email: summarizeEmail(email, context.userEmail) };
    }
    return { kind: "payoff", ...result };
  }

  if (action.kind === "reschedule") {
    const result = servicingExecuteReschedule({
      loan_id: action.loan_id,
      new_date_iso: action.new_date_iso,
    });
    if ("ok" in result && result.ok) {
      const email = await sendRescheduleEmail({
        to: context.userEmail,
        firstName: context.firstName,
        merchant: result.merchant,
        previousDueIso: result.previous_due_iso,
        newDueIso: result.new_due_iso,
        nextInstallmentUsd: result.next_installment_usd,
        referenceId: result.reference_id,
      });
      return {
        kind: "reschedule",
        ...result,
        email: summarizeEmail(email, context.userEmail),
      };
    }
    return { kind: "reschedule", ...result };
  }

  // pay_installment
  const result = servicingPayInstallment({
    loan_id: action.loan_id,
    amount_usd: action.amount_usd,
    funding_source_id: action.funding_source_id,
  });
  if ("ok" in result && result.ok) {
    const email = await sendPayInstallmentEmail({
      to: context.userEmail,
      firstName: context.firstName,
      merchant: result.merchant,
      amountUsd: result.amount_usd,
      fundingSourceLabel: result.funding_source_label,
      referenceId: result.reference_id,
    });
    return {
      kind: "pay_installment",
      ...result,
      email: summarizeEmail(email, context.userEmail),
    };
  }
  return { kind: "pay_installment", ...result };
}

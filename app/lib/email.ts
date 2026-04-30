import { Resend } from "resend";

export type PurchaseEmailPayload = {
  to: string;
  firstName: string;
  merchant: string;
  productTitle: string;
  productUrl?: string;
  productImageUrl?: string | null;
  totalUsd: number;
  planLabel: string;
  planCadence: "biweekly" | "monthly";
  planMonthlyUsd: number;
  planApr: number;
  planTotalPayments: number;
  firstPaymentDate: string;
  paymentSchedule: string[];
  orderDate: string;
  confirmationCode: string;
  estimatedDelivery: string;
};

function formatUSD(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function hostnameFrom(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function urlIsReachable(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return true;
    // Some CDNs reject HEAD — try a tiny ranged GET.
    if (res.status === 405 || res.status === 403) {
      const ctl2 = new AbortController();
      const timer2 = setTimeout(() => ctl2.abort(), timeoutMs);
      try {
        const res2 = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: { Range: "bytes=0-1" },
          signal: ctl2.signal,
        });
        return res2.ok || res2.status === 206;
      } finally {
        clearTimeout(timer2);
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function resolveHeroImage(
  productImageUrl: string | null | undefined,
  productUrl: string | undefined
): Promise<string | null> {
  if (productImageUrl && (await urlIsReachable(productImageUrl))) {
    return productImageUrl;
  }
  const host = hostnameFrom(productUrl);
  if (host) {
    const logo = `https://logo.clearbit.com/${host}`;
    if (await urlIsReachable(logo)) return logo;
  }
  return null;
}

function renderText(p: PurchaseEmailPayload): string {
  const schedule = p.paymentSchedule
    .map(
      (d, i) =>
        `  ${i + 1}. ${d} — ${formatUSD(p.planMonthlyUsd)}${
          i === 0 && p.planCadence === "biweekly" ? " (at checkout)" : ""
        }`
    )
    .join("\n");
  return `Order confirmed — ${p.confirmationCode}

Hi ${p.firstName},

Thanks for your order at ${p.merchant}. Here's your receipt.

ORDER
${p.productTitle}
${p.merchant}
${formatUSD(p.totalUsd)}

PAYMENT PLAN — ${p.planLabel} · ${p.planApr === 0 ? "0% APR" : `${p.planApr}% APR`}
${p.planTotalPayments} payments of ${formatUSD(p.planMonthlyUsd)} ${
    p.planCadence === "biweekly" ? "every 2 weeks" : "monthly"
  }.

SCHEDULE
${schedule}

ORDER DETAILS
Order date:       ${p.orderDate}
Estimated delivery: ${p.estimatedDelivery}
Confirmation:     ${p.confirmationCode}

What's next
- ${p.merchant} will email shipping details separately.
- Autopay is enrolled for your plan. First payment ${formatUSD(
    p.planMonthlyUsd
  )} on ${p.firstPaymentDate}.
- Manage or pay early anytime in the Affirm app.

Questions? support@affirm.com

Affirm, Inc. · San Francisco, CA
Rates from 0–36% APR. Payment options through Affirm depend on purchase amount and eligibility. Pay in 4 is 0% APR and not a loan. California residents: Loans by Affirm Loan Services, LLC, made or arranged pursuant to a California Finance Lender license.
`;
}

function renderHtml(
  p: PurchaseEmailPayload,
  resolvedImage: { url: string; kind: "photo" | "logo" } | null
): string {
  const aprLabel = p.planApr === 0 ? "0% APR" : `${p.planApr}% APR`;
  const cadenceLabel =
    p.planCadence === "biweekly" ? "every 2 weeks" : "monthly";

  const imageCell = resolvedImage
    ? resolvedImage.kind === "photo"
      ? `<img src="${resolvedImage.url}" alt="${p.productTitle}" width="72" height="72" style="display:block;border:0;border-radius:8px;object-fit:cover;width:72px;height:72px;background:#eef0f3;" />`
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:72px;height:72px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;"><tr><td align="center" valign="middle" style="width:72px;height:72px;"><img src="${resolvedImage.url}" alt="${p.merchant}" width="48" height="48" style="display:block;border:0;width:48px;height:48px;object-fit:contain;" /></td></tr></table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:72px;height:72px;background:linear-gradient(135deg,#7A00FF 0%,#b06bff 100%);border-radius:8px;"><tr><td align="center" valign="middle" style="width:72px;height:72px;color:white;font-size:22px;font-weight:600;font-family:-apple-system,sans-serif;">${p.merchant
        .charAt(0)
        .toUpperCase()}</td></tr></table>`;

  const scheduleRows = p.paymentSchedule
    .map((date, i) => {
      const isLast = i === p.paymentSchedule.length - 1;
      const note =
        i === 0 && p.planCadence === "biweekly"
          ? `<span style="color:#6b7280;font-size:11px;font-weight:500;margin-left:6px;">at checkout</span>`
          : "";
      const borderStyle = isLast ? "" : "border-bottom:1px solid #f0f1f4;";
      return `<tr>
        <td style="padding:12px 0;${borderStyle}font-size:13px;color:#6b7280;width:40px;">${
        i + 1
      }</td>
        <td style="padding:12px 0;${borderStyle}font-size:13px;color:#0a2540;font-weight:500;">${date}${note}</td>
        <td align="right" style="padding:12px 0;${borderStyle}font-size:13px;color:#0a2540;font-weight:600;">${formatUSD(
        p.planMonthlyUsd
      )}</td>
      </tr>`;
    })
    .join("");

  const productLink = p.productUrl
    ? `<a href="${p.productUrl}" style="font-size:12px;color:#7A00FF;text-decoration:none;display:inline-block;margin-top:6px;font-weight:500;">View product →</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Your Affirm order — ${p.confirmationCode}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a2540;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">Order ${
    p.confirmationCode
  } · ${p.planLabel} · First payment ${p.firstPaymentDate}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
    <tr><td align="center" style="padding:32px 16px 40px;">

      <!-- Wordmark -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td style="padding:0 4px 20px;">
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:700;color:#0a2540;letter-spacing:-0.6px;">affirm</div>
        </td></tr>
      </table>

      <!-- Main card -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(10,37,64,0.04),0 4px 16px rgba(10,37,64,0.06);">

        <!-- Hero -->
        <tr><td style="padding:36px 36px 24px;">
          <div style="font-size:12px;color:#6b7280;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;">Order ${
            p.confirmationCode
          }</div>
          <div style="font-size:26px;font-weight:600;color:#0a2540;margin-top:8px;line-height:1.25;letter-spacing:-0.4px;">Thanks, ${
            p.firstName
          } — your order is confirmed.</div>
          <div style="font-size:15px;color:#4b5563;margin-top:10px;line-height:1.55;">${
            p.merchant
          } is preparing your order now. We'll share shipping details as soon as they're available.</div>
        </td></tr>

        <!-- Product block -->
        <tr><td style="padding:0 36px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;border-radius:12px;">
            <tr><td style="padding:18px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="72" valign="top">${imageCell}</td>
                  <td valign="top" style="padding-left:16px;">
                    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${
                      p.merchant
                    }</div>
                    <div style="font-size:15px;font-weight:600;color:#0a2540;margin-top:4px;line-height:1.35;">${
                      p.productTitle
                    }</div>
                    ${productLink}
                  </td>
                  <td align="right" valign="top">
                    <div style="font-size:15px;font-weight:600;color:#0a2540;white-space:nowrap;">${formatUSD(
                      p.totalUsd
                    )}</div>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Order summary -->
        <tr><td style="padding:0 36px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding:8px 0;font-size:13px;color:#6b7280;">Subtotal</td>
              <td align="right" style="padding:8px 0;font-size:13px;color:#0a2540;">${formatUSD(
                p.totalUsd
              )}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-size:13px;color:#6b7280;">Shipping</td>
              <td align="right" style="padding:8px 0;font-size:13px;color:#0a2540;">Calculated at shipment</td>
            </tr>
            <tr>
              <td style="padding:10px 0 4px;font-size:14px;color:#0a2540;font-weight:600;border-top:1px solid #e5e7eb;">Total</td>
              <td align="right" style="padding:10px 0 4px;font-size:14px;color:#0a2540;font-weight:600;border-top:1px solid #e5e7eb;">${formatUSD(
                p.totalUsd
              )}</td>
            </tr>
          </table>
        </td></tr>

        <!-- Plan header + schedule -->
        <tr><td style="padding:20px 36px 8px;">
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Your payment plan</div>
          <div style="font-size:20px;font-weight:600;color:#0a2540;margin-top:6px;letter-spacing:-0.2px;">${
            p.planLabel
          } <span style="color:#7A00FF;">· ${aprLabel}</span></div>
          <div style="font-size:13px;color:#4b5563;margin-top:4px;">${
            p.planTotalPayments
          } payments of ${formatUSD(
    p.planMonthlyUsd
  )} ${cadenceLabel}. Autopay is enrolled.</div>
        </td></tr>

        <tr><td style="padding:12px 36px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:12px;">
            <tr><td style="padding:6px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${scheduleRows}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Order details -->
        <tr><td style="padding:16px 36px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding:8px 0;border-top:1px solid #f0f1f4;font-size:13px;color:#6b7280;">Order date</td>
              <td align="right" style="padding:8px 0;border-top:1px solid #f0f1f4;font-size:13px;color:#0a2540;">${
                p.orderDate
              }</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-top:1px solid #f0f1f4;font-size:13px;color:#6b7280;">Estimated delivery</td>
              <td align="right" style="padding:8px 0;border-top:1px solid #f0f1f4;font-size:13px;color:#0a2540;">${
                p.estimatedDelivery
              }</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-top:1px solid #f0f1f4;font-size:13px;color:#6b7280;">Confirmation</td>
              <td align="right" style="padding:8px 0;border-top:1px solid #f0f1f4;font-size:13px;color:#0a2540;font-family:'SF Mono',Menlo,monospace;">${
                p.confirmationCode
              }</td>
            </tr>
          </table>
        </td></tr>

        <!-- What's next -->
        <tr><td style="padding:20px 36px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8ff;border-radius:12px;">
            <tr><td style="padding:18px 20px;">
              <div style="font-size:11px;color:#7A00FF;text-transform:uppercase;letter-spacing:0.6px;font-weight:700;">What's next</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
                <tr><td style="padding:4px 0;font-size:13px;color:#0a2540;line-height:1.55;">• ${
                  p.merchant
                } will email shipping details separately.</td></tr>
                <tr><td style="padding:4px 0;font-size:13px;color:#0a2540;line-height:1.55;">• First payment of <strong>${formatUSD(
                  p.planMonthlyUsd
                )}</strong> is scheduled for <strong>${
    p.firstPaymentDate
  }</strong>.</td></tr>
                <tr><td style="padding:4px 0;font-size:13px;color:#0a2540;line-height:1.55;">• Manage your plan or pay early anytime in the Affirm app.</td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>

      </table>

      <!-- Footer -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td style="padding:24px 16px 8px;text-align:center;">
          <div style="font-size:12px;color:#6b7280;line-height:1.6;">Questions about your order? Contact <a href="mailto:support@affirm.com" style="color:#7A00FF;text-decoration:none;font-weight:500;">support@affirm.com</a></div>
        </td></tr>
        <tr><td style="padding:16px 16px 4px;text-align:center;">
          <div style="font-size:11px;color:#9ca3af;line-height:1.7;">
            Affirm, Inc. · San Francisco, CA<br>
            Rates from 0–36% APR. Payment options through Affirm depend on purchase amount, merchant, and eligibility, and may not be available in all states. Affirm Pay in 4 is 0% APR and not a loan. California residents: Loans by Affirm Loan Services, LLC, made or arranged pursuant to a California Finance Lender license. Loans in other states may be originated by Affirm, Inc. or Celtic Bank.
          </div>
        </td></tr>
        <tr><td style="padding:12px 16px 0;text-align:center;">
          <div style="font-size:10px;color:#c5cad1;">Prototype — Affirm Agent hackathon · do not reply</div>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

export type SendPurchaseEmailResult =
  | { sent: true; id: string }
  | { sent: false; skipped: true; reason: string }
  | { sent: false; skipped: false; error: string };

// ---------------------------------------------------------------------------
// Servicing emails (payoff, reschedule, pay-installment)
// ---------------------------------------------------------------------------

export type ServicingEmailKind = "payoff" | "reschedule" | "pay_installment";

export type SendServicingEmailResult = SendPurchaseEmailResult;

export type PayoffEmailPayload = {
  to: string;
  firstName: string;
  merchant: string;
  amountUsd: number;
  fundingSourceLabel: string;
  referenceId: string;
};

export type RescheduleEmailPayload = {
  to: string;
  firstName: string;
  merchant: string;
  previousDueIso: string; // YYYY-MM-DD
  newDueIso: string; // YYYY-MM-DD
  nextInstallmentUsd: number;
  referenceId: string;
};

export type PayInstallmentEmailPayload = {
  to: string;
  firstName: string;
  merchant: string;
  amountUsd: number;
  fundingSourceLabel: string;
  referenceId: string;
};

function isoToLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

type ServicingTemplate = {
  subject: string;
  preheader: string;
  eyebrow: string;
  hero: string;
  intro: string;
  rows: { label: string; value: string }[];
  whatsNext: string[];
};

function buildPayoffTemplate(p: PayoffEmailPayload): ServicingTemplate {
  return {
    subject: `Your ${p.merchant} loan is paid off — ${p.referenceId}`,
    preheader: `${formatUSD(p.amountUsd)} payoff submitted from ${p.fundingSourceLabel}.`,
    eyebrow: "Loan paid off",
    hero: `Done — your ${p.merchant} loan is paid off, ${p.firstName}.`,
    intro: `We submitted ${formatUSD(p.amountUsd)} from ${p.fundingSourceLabel}. The loan will close once the payment posts in 1–3 business days. You'll see a final statement in your Affirm app.`,
    rows: [
      { label: "Merchant", value: p.merchant },
      { label: "Payoff amount", value: formatUSD(p.amountUsd) },
      { label: "Funding source", value: p.fundingSourceLabel },
      { label: "Reference", value: p.referenceId },
    ],
    whatsNext: [
      "We'll email a final closing statement once the payment posts.",
      "Autopay for this plan has been canceled.",
      "Nothing more is owed on this loan.",
    ],
  };
}

function buildRescheduleTemplate(p: RescheduleEmailPayload): ServicingTemplate {
  return {
    subject: `Your ${p.merchant} payment date was updated — ${p.referenceId}`,
    preheader: `New due date: ${isoToLabel(p.newDueIso)}.`,
    eyebrow: "Payment date updated",
    hero: `Your ${p.merchant} payment was rescheduled, ${p.firstName}.`,
    intro: `Your next ${p.merchant} payment of ${formatUSD(p.nextInstallmentUsd)} will now run on ${isoToLabel(p.newDueIso)} instead of ${isoToLabel(p.previousDueIso)}. Nothing else about your plan changed.`,
    rows: [
      { label: "Merchant", value: p.merchant },
      { label: "Previous due date", value: isoToLabel(p.previousDueIso) },
      { label: "New due date", value: isoToLabel(p.newDueIso) },
      { label: "Amount", value: formatUSD(p.nextInstallmentUsd) },
      { label: "Reference", value: p.referenceId },
    ],
    whatsNext: [
      `Autopay will run on ${isoToLabel(p.newDueIso)} from your selected funding source.`,
      "Your remaining payment schedule and total cost have not changed.",
      "You can reschedule again from the Affirm Assistant if you need to.",
    ],
  };
}

function buildPayInstallmentTemplate(
  p: PayInstallmentEmailPayload
): ServicingTemplate {
  return {
    subject: `Payment received toward your ${p.merchant} loan — ${p.referenceId}`,
    preheader: `${formatUSD(p.amountUsd)} applied from ${p.fundingSourceLabel}.`,
    eyebrow: "Extra payment received",
    hero: `Got it — ${formatUSD(p.amountUsd)} applied to your ${p.merchant} loan.`,
    intro: `We received ${formatUSD(p.amountUsd)} from ${p.fundingSourceLabel} and applied it toward your next ${p.merchant} installment. Your balance has been updated and your remaining schedule will reflect this payment once it posts (1–3 business days).`,
    rows: [
      { label: "Merchant", value: p.merchant },
      { label: "Amount", value: formatUSD(p.amountUsd) },
      { label: "Funding source", value: p.fundingSourceLabel },
      { label: "Reference", value: p.referenceId },
    ],
    whatsNext: [
      "Your next scheduled payment may be reduced or skipped depending on what's left on the plan.",
      "Autopay continues for any remaining payments.",
      "Open the Affirm app to see your updated schedule.",
    ],
  };
}

function renderServicingHtml(t: ServicingTemplate): string {
  const rowsHtml = t.rows
    .map((r, i) => {
      const isFirst = i === 0;
      return `<tr>
        <td style="padding:10px 0;${isFirst ? "" : "border-top:1px solid #f0f1f4;"}font-size:13px;color:#6b7280;">${r.label}</td>
        <td align="right" style="padding:10px 0;${isFirst ? "" : "border-top:1px solid #f0f1f4;"}font-size:13px;color:#0a2540;font-weight:500;">${r.value}</td>
      </tr>`;
    })
    .join("");

  const nextHtml = t.whatsNext
    .map(
      (line) =>
        `<tr><td style="padding:4px 0;font-size:13px;color:#0a2540;line-height:1.55;">• ${line}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${t.subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a2540;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;">${t.preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
    <tr><td align="center" style="padding:32px 16px 40px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td style="padding:0 4px 20px;">
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:700;color:#0a2540;letter-spacing:-0.6px;">affirm</div>
        </td></tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(10,37,64,0.04),0 4px 16px rgba(10,37,64,0.06);">
        <tr><td style="padding:36px 36px 24px;">
          <div style="font-size:12px;color:#7A00FF;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">${t.eyebrow}</div>
          <div style="font-size:24px;font-weight:600;color:#0a2540;margin-top:10px;line-height:1.3;letter-spacing:-0.4px;">${t.hero}</div>
          <div style="font-size:15px;color:#4b5563;margin-top:12px;line-height:1.55;">${t.intro}</div>
        </td></tr>
        <tr><td style="padding:0 36px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;border-radius:12px;">
            <tr><td style="padding:18px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 36px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8ff;border-radius:12px;">
            <tr><td style="padding:18px 20px;">
              <div style="font-size:11px;color:#7A00FF;text-transform:uppercase;letter-spacing:0.6px;font-weight:700;">What's next</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${nextHtml}</table>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td style="padding:24px 16px 8px;text-align:center;">
          <div style="font-size:12px;color:#6b7280;line-height:1.6;">Questions? Contact <a href="mailto:support@affirm.com" style="color:#7A00FF;text-decoration:none;font-weight:500;">support@affirm.com</a></div>
        </td></tr>
        <tr><td style="padding:16px 16px 4px;text-align:center;">
          <div style="font-size:11px;color:#9ca3af;line-height:1.7;">
            Affirm, Inc. · San Francisco, CA<br>
            Loans by Affirm Loan Services, LLC, made or arranged pursuant to a California Finance Lender license. Loans in other states may be originated by Affirm, Inc. or Celtic Bank.
          </div>
        </td></tr>
        <tr><td style="padding:12px 16px 0;text-align:center;">
          <div style="font-size:10px;color:#c5cad1;">Prototype — Affirm Agent hackathon · do not reply</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderServicingText(t: ServicingTemplate): string {
  const rows = t.rows.map((r) => `${r.label}: ${r.value}`).join("\n");
  const next = t.whatsNext.map((line) => `- ${line}`).join("\n");
  return `${t.eyebrow.toUpperCase()}

${t.hero}

${t.intro}

${rows}

WHAT'S NEXT
${next}

Questions? support@affirm.com

Affirm, Inc. · San Francisco, CA
Prototype — Affirm Agent hackathon · do not reply
`;
}

async function sendServicingEmail(
  to: string,
  template: ServicingTemplate
): Promise<SendServicingEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, skipped: true, reason: "RESEND_API_KEY not set" };
  }
  const from = process.env.RESEND_FROM ?? "Affirm <onboarding@resend.dev>";
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject: template.subject,
      html: renderServicingHtml(template),
      text: renderServicingText(template),
    });
    if (error) return { sent: false, skipped: false, error: error.message };
    return { sent: true, id: data?.id ?? "" };
  } catch (err) {
    return {
      sent: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function sendPayoffEmail(p: PayoffEmailPayload) {
  return sendServicingEmail(p.to, buildPayoffTemplate(p));
}

export function sendRescheduleEmail(p: RescheduleEmailPayload) {
  return sendServicingEmail(p.to, buildRescheduleTemplate(p));
}

export function sendPayInstallmentEmail(p: PayInstallmentEmailPayload) {
  return sendServicingEmail(p.to, buildPayInstallmentTemplate(p));
}

export async function sendPurchaseEmail(
  payload: PurchaseEmailPayload
): Promise<SendPurchaseEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, skipped: true, reason: "RESEND_API_KEY not set" };
  }
  const from = process.env.RESEND_FROM ?? "Affirm <onboarding@resend.dev>";

  try {
    const resolvedUrl = await resolveHeroImage(
      payload.productImageUrl,
      payload.productUrl
    );
    const resolvedImage = resolvedUrl
      ? {
          url: resolvedUrl,
          kind:
            resolvedUrl === payload.productImageUrl
              ? ("photo" as const)
              : ("logo" as const),
        }
      : null;

    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to: payload.to,
      subject: `Your Affirm order at ${payload.merchant} is confirmed — ${payload.confirmationCode}`,
      html: renderHtml(payload, resolvedImage),
      text: renderText(payload),
    });
    if (error) {
      return { sent: false, skipped: false, error: error.message };
    }
    return { sent: true, id: data?.id ?? "" };
  } catch (err) {
    return {
      sent: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

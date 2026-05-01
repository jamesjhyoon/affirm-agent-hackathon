import { DEMO_USER } from "./mockData";
import {
  servicingOpenRefundCase,
  servicingOptimizationOptions,
  servicingPayoffQuote,
  servicingReschedulePreview,
  servicingTriageOptions,
} from "./servicing";
import { MERCHANTS, SHOPPABLE_MERCHANTS } from "./merchants";
import {
  getProductById,
  searchShopifyProducts,
  searchShopifyByDomain,
  type UnifiedProduct,
} from "./shopify";
import {
  getWebProductById,
  resolveMerchantHint,
  searchProductsViaWeb,
} from "./webSearch";
import { sendPurchaseEmail } from "./email";
import { TOOL_DEFINITIONS } from "./toolSchemas";

// Tool schemas live in toolSchemas.ts so the eval suite can import them
// without dragging in runtime side effects (Resend, Anthropic web-search
// client, etc.). Re-exported here so existing call sites (the chat route)
// don't have to change their import path.
export { TOOL_DEFINITIONS };

export type ToolContext = {
  userEmail: string;
  firstName: string;
};

type SearchProductsInput = {
  query: string;
  max_price?: number;
  merchant?: string;
};
type ListMerchantsInput = { category?: string };
type CalculateTermsInput = { price: number };
type ExecutePurchaseInput = { product_id: string; plan_id: string };
type ServicingPayoffQuoteInput = { loan_id?: string; merchant_hint?: string };
type ServicingReschedulePreviewInput = {
  loan_id?: string;
  merchant_hint?: string;
  requested_date_iso?: string;
};
type ServicingRefundCaseInput = { loan_id?: string; merchant_hint?: string };
type ServicingTriageInput = { constraint?: string };
type ServicingOptimizationInput = { amount_usd?: number };

function toClientProduct(p: UnifiedProduct) {
  return {
    id: p.id,
    merchant_id: p.merchantId,
    merchant: p.merchantName,
    title: p.title,
    price: p.price,
    description: p.description,
    url: p.url,
    image_url: p.imageUrl,
    product_type: p.productType,
  };
}

async function searchProducts(input: SearchProductsInput) {
  const hint = input.merchant?.trim();
  const resolved = hint ? resolveMerchantHint(hint) : null;

  const shopifyMatch = resolved
    ? SHOPPABLE_MERCHANTS.find(
        (m) =>
          Boolean(m.shopifyDomain) &&
          (m.name.toLowerCase() === resolved.name.toLowerCase() ||
            (resolved.domain && m.domain === resolved.domain))
      )
    : null;

  let products: UnifiedProduct[] = [];
  let source: "shopify" | "web" | "none" = "none";

  if (shopifyMatch) {
    products = await searchShopifyProducts(input.query, {
      maxPrice: input.max_price,
      merchantIds: [shopifyMatch.id],
      limit: 4,
    });
    source = products.length > 0 ? "shopify" : "none";
  } else if (resolved) {
    if (resolved.domain) {
      try {
        products = await searchShopifyByDomain(
          resolved.domain,
          resolved.name,
          input.query,
          { maxPrice: input.max_price, limit: 4 }
        );
        source = products.length > 0 ? "shopify" : "none";
      } catch (err) {
        console.error("[shopify dynamic] failed:", err);
      }
    }

    if (products.length === 0) {
      try {
        products = await searchProductsViaWeb(input.query, {
          merchantDomain: resolved.domain,
          merchantName: resolved.name,
          maxPrice: input.max_price,
          limit: 4,
        });
        source = products.length > 0 ? "web" : "none";
      } catch (err) {
        console.error("[web_search scoped] failed:", err);
      }
    }

    // Intentionally NO open-web fallback here. If the user asked for a specific
    // merchant, honor the scope — better to return 0 and let the agent suggest
    // alternatives than to silently surface products from a different store.
  } else {
    products = await searchShopifyProducts(input.query, {
      maxPrice: input.max_price,
      limit: 4,
    });
    source = products.length > 0 ? "shopify" : "none";

    if (products.length === 0) {
      try {
        products = await searchProductsViaWeb(input.query, {
          maxPrice: input.max_price,
          limit: 4,
        });
        source = products.length > 0 ? "web" : "none";
      } catch (err) {
        console.error("[web_search open] failed:", err);
      }
    }
  }

  return {
    query: input.query,
    merchant: resolved
      ? { name: resolved.name, domain: resolved.domain ?? null }
      : null,
    source,
    result_count: products.length,
    results: products.map(toClientProduct),
    note:
      products.length === 0
        ? `No matching products found. Try broader terms, a different merchant, or list_merchants.`
        : undefined,
  };
}

function listMerchants(input: ListMerchantsInput) {
  const filtered = input.category
    ? MERCHANTS.filter(
        (m) => m.category.toLowerCase() === input.category!.toLowerCase()
      )
    : MERCHANTS;

  return {
    category: input.category ?? null,
    total: filtered.length,
    merchants: filtered.map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      description: m.description,
      domain: m.domain,
      shoppable: m.shoppable,
    })),
    note: `${SHOPPABLE_MERCHANTS.length} of these ${MERCHANTS.length} merchants support live product search in this prototype. All are real Affirm-integrated merchants.`,
  };
}

function checkAffirmCapacity() {
  return {
    user_first_name: DEMO_USER.firstName,
    available_credit_usd: DEMO_USER.availableCredit,
    active_plans: DEMO_USER.activePlans.map((p) => ({
      id: p.id,
      merchant: p.merchant,
      merchant_domain: p.merchantDomain,
      balance_usd: p.balance,
      monthly_payment_usd: p.monthlyPayment,
      months_remaining: p.termMonthsRemaining,
      // APR exposed on the snapshot so the LLM can answer "which plan
      // costs the most to carry?" without a second tool call. Surfaced
      // as basis points to keep precision; UI formats to "x.xx% APR".
      apr_bps: p.aprBps,
      next_payment_date: p.nextPaymentDate,
    })),
    total_monthly_obligation_usd: DEMO_USER.activePlans.reduce(
      (sum, p) => sum + p.monthlyPayment,
      0
    ),
  };
}

function calculateAffirmTerms(input: CalculateTermsInput) {
  const price = input.price;
  const round = (n: number) => Math.round(n * 100) / 100;
  const plans = [
    {
      id: "plan_payin4",
      label: "Pay in 4",
      total_payments: 4,
      cadence: "biweekly",
      apr: 0,
      monthly_payment_usd: round(price / 4),
      total_cost_usd: round(price),
    },
    {
      id: "plan_6mo",
      label: "6 months",
      total_payments: 6,
      cadence: "monthly",
      apr: 10,
      monthly_payment_usd: round((price * 1.025) / 6),
      total_cost_usd: round(price * 1.025),
    },
    {
      id: "plan_12mo",
      label: "12 months",
      total_payments: 12,
      cadence: "monthly",
      apr: 15,
      monthly_payment_usd: round((price * 1.075) / 12),
      total_cost_usd: round(price * 1.075),
    },
  ];
  return { price_usd: price, plans };
}

type PlanTerms = {
  id: string;
  label: string;
  cadence: "biweekly" | "monthly";
  apr: number;
  total_payments: number;
  monthly_payment_usd: number;
  total_cost_usd: number;
};

function planTermsFor(planId: string, price: number): PlanTerms | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  if (planId === "plan_payin4") {
    return {
      id: planId,
      label: "Pay in 4",
      cadence: "biweekly",
      apr: 0,
      total_payments: 4,
      monthly_payment_usd: round(price / 4),
      total_cost_usd: round(price),
    };
  }
  if (planId === "plan_6mo") {
    return {
      id: planId,
      label: "6 months",
      cadence: "monthly",
      apr: 10,
      total_payments: 6,
      monthly_payment_usd: round((price * 1.025) / 6),
      total_cost_usd: round(price * 1.025),
    };
  }
  if (planId === "plan_12mo") {
    return {
      id: planId,
      label: "12 months",
      cadence: "monthly",
      apr: 15,
      total_payments: 12,
      monthly_payment_usd: round((price * 1.075) / 12),
      total_cost_usd: round(price * 1.075),
    };
  }
  return null;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function paymentScheduleFor(
  cadence: "biweekly" | "monthly",
  total: number
): Date[] {
  const now = new Date();
  const dates: Date[] = [];
  if (cadence === "biweekly") {
    // Pay in 4: 1st payment at checkout (today), then every 2 weeks.
    dates.push(new Date(now));
    for (let i = 1; i < total; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + 14 * i);
      dates.push(d);
    }
  } else {
    // Monthly: 1st payment ~30 days after purchase.
    for (let i = 0; i < total; i++) {
      const d = new Date(now);
      d.setMonth(d.getMonth() + (i + 1));
      dates.push(d);
    }
  }
  return dates;
}

async function executePurchase(
  input: ExecutePurchaseInput,
  ctx: ToolContext
) {
  const shopifyProduct = getProductById(input.product_id);
  const product = shopifyProduct ?? getWebProductById(input.product_id);
  const platform: "shopify" | "web" = shopifyProduct ? "shopify" : "web";
  if (!product) {
    return {
      error: `Unknown product_id: ${input.product_id}. Make sure to use the exact ID returned by search_products.`,
    };
  }
  const plan = planTermsFor(input.plan_id, product.price);
  if (!plan) {
    return {
      error: `Unknown plan_id: ${input.plan_id}. Use one returned by calculate_affirm_terms.`,
    };
  }

  const confirmationCode = `AF${Math.random()
    .toString(36)
    .slice(2, 10)
    .toUpperCase()}`;
  const estimatedDelivery = "3-5 business days";
  const scheduleDates = paymentScheduleFor(plan.cadence, plan.total_payments);
  const paymentSchedule = scheduleDates.map(formatDate);
  const firstPaymentDate = paymentSchedule[0];
  const orderDate = formatDate(new Date());

  const emailResult = await sendPurchaseEmail({
    to: ctx.userEmail,
    firstName: ctx.firstName,
    merchant: product.merchantName,
    productTitle: product.title,
    productUrl: product.url,
    productImageUrl: product.imageUrl,
    totalUsd: product.price,
    planLabel: plan.label,
    planCadence: plan.cadence,
    planMonthlyUsd: plan.monthly_payment_usd,
    planApr: plan.apr,
    planTotalPayments: plan.total_payments,
    firstPaymentDate,
    paymentSchedule,
    orderDate,
    confirmationCode,
    estimatedDelivery,
  });

  const email = emailResult.sent
    ? { status: "sent" as const, to: ctx.userEmail }
    : emailResult.skipped
    ? { status: "skipped" as const, reason: emailResult.reason }
    : { status: "failed" as const, error: emailResult.error };

  return {
    status: "confirmed" as const,
    confirmation_code: confirmationCode,
    platform,
    product: {
      id: product.id,
      title: product.title,
      merchant: product.merchantName,
      price_usd: product.price,
      image_url: product.imageUrl,
      url: product.url,
    },
    plan: {
      id: plan.id,
      label: plan.label,
      cadence: plan.cadence,
      apr: plan.apr,
      total_payments: plan.total_payments,
      monthly_payment_usd: plan.monthly_payment_usd,
      total_cost_usd: plan.total_cost_usd,
      first_payment_date: firstPaymentDate,
    },
    estimated_delivery: estimatedDelivery,
    email,
    message: `Purchase confirmed. ${product.merchantName} will email shipping details, your Affirm plan is active, and we sent a receipt to ${ctx.userEmail}.`,
  };
}

export async function dispatchTool(
  name: string,
  input: unknown,
  context: ToolContext
): Promise<unknown> {
  switch (name) {
    case "search_products":
      return await searchProducts(input as SearchProductsInput);
    case "list_merchants":
      return listMerchants(input as ListMerchantsInput);
    case "check_affirm_capacity":
      return checkAffirmCapacity();
    case "calculate_affirm_terms":
      return calculateAffirmTerms(input as CalculateTermsInput);
    case "execute_purchase":
      return await executePurchase(input as ExecutePurchaseInput, context);
    case "servicing_payoff_quote":
      return servicingPayoffQuote(input as ServicingPayoffQuoteInput);
    case "servicing_reschedule_preview":
      return servicingReschedulePreview(input as ServicingReschedulePreviewInput);
    case "servicing_refund_case":
      return servicingOpenRefundCase(input as ServicingRefundCaseInput);
    case "servicing_triage_options":
      return servicingTriageOptions(input as ServicingTriageInput);
    case "servicing_optimization_options":
      return servicingOptimizationOptions(input as ServicingOptimizationInput);
    // Note: servicing execute paths are intentionally NOT exposed to the LLM.
    // They live behind /api/servicing/execute and require a verified WebAuthn
    // assertion. The agent surfaces quote/preview cards; the user authorizes
    // with Touch ID / Face ID; the deterministic executor runs the action.
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

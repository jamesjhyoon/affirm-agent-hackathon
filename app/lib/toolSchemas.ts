import type Anthropic from "@anthropic-ai/sdk";

/**
 * Pure-data tool schemas. NO runtime side effects on import — the eval suite
 * (scripts/run-evals.ts) imports this without dragging in Resend, web search,
 * or anything else that would need real env credentials at module load. The
 * actual dispatch logic lives in app/lib/tools.ts and is the only consumer of
 * the runtime-side modules.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description:
      "Search for real products across Affirm's merchant network. Affirm works with hundreds of thousands of merchants — this tool can find real listings at any of them. Fast path (~1s) for 10 Shopify-integrated merchants (Allbirds, Rothy's, Taylor Stitch, Everlane, Casper, Tuft & Needle, Brooklinen, Parachute, Therabody, Jackery). For any other merchant or the open web, it uses real-time web search (~5-15s). Returns products with title, merchant, price, and image URL.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What the user wants to buy (e.g. 'running shoes', 'mattress', 'portable power station'). Be specific.",
        },
        max_price: {
          type: "number",
          description: "Optional maximum price filter in USD.",
        },
        merchant: {
          type: "string",
          description:
            "Optional merchant to restrict the search to. Accepts a name ('Peloton', 'Amazon', 'Best Buy'), an Affirm merchant id ('peloton'), or a domain ('amazon.com'). Leave empty for the best retailer across the web.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_merchants",
    description:
      "List merchants in Affirm's network. Use this when the user asks what stores they can shop at, or when a product search returns nothing and you want to suggest categories to browse.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Optional category filter (e.g. 'Shoes', 'Mattresses', 'Home', 'Fitness', 'Apparel', 'Electronics', 'Travel', 'Wellness', 'Outdoor', 'Beauty', 'Jewelry').",
        },
      },
    },
  },
  {
    name: "check_affirm_capacity",
    description:
      "Check the user's Affirm account: available credit limit and active payment plans. Call this before recommending purchases to make sure they're within the user's capacity.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "calculate_affirm_terms",
    description:
      "Given a product price, return available Affirm payment plan options (pay in 4, 6mo, 12mo) with monthly payment and APR.",
    input_schema: {
      type: "object",
      properties: {
        price: {
          type: "number",
          description: "Total price of the product in USD",
        },
      },
      required: ["price"],
    },
  },
  {
    name: "execute_purchase",
    description:
      "Complete the purchase. Requires the product_id (from search_products) and the chosen plan_id (from calculate_affirm_terms). Only call this after the user has explicitly confirmed.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "Product ID from search_products" },
        plan_id: { type: "string", description: "Plan ID from calculate_affirm_terms" },
      },
      required: ["product_id", "plan_id"],
    },
  },
  {
    name: "servicing_payoff_quote",
    description:
      "Get a deterministic payoff quote for an existing installment loan (merchant installment plans). Call before executing payoff. Amounts come from servicing mock data — not inferred by the LLM.",
    input_schema: {
      type: "object",
      properties: {
        loan_id: {
          type: "string",
          description:
            "Loan id from check_affirm_capacity (e.g. plan_peloton). Optional if merchant_hint is enough.",
        },
        merchant_hint: {
          type: "string",
          description:
            "Merchant name substring if user names the purchase (Peloton, Nike, Marriott).",
        },
      },
    },
  },
  {
    name: "servicing_reschedule_preview",
    description:
      "Preview reschedule eligibility for the next installment: allowed target dates and policy blocks (e.g. RSH-MAX_WINDOW, RSH-CYCLE_LIMIT). Surface this card and let the user tap Confirm with biometric to actually execute.",
    input_schema: {
      type: "object",
      properties: {
        loan_id: { type: "string" },
        merchant_hint: { type: "string" },
        requested_date_iso: {
          type: "string",
          description: "Optional YYYY-MM-DD if user asked for a specific date — checks against policy window.",
        },
      },
    },
  },
  {
    name: "servicing_triage_options",
    description:
      "Cross-plan triage when the user describes a cash-flow constraint ('I'm short this month', 'tight on cash', 'going to be short', 'can't make all my payments', 'need more time'). Returns ALL active plans sorted by next due date with per-plan reschedule eligibility (which ones haven't used their cycle reschedule yet) and a deterministic recommendation. The card lets the user see every upcoming payment at once and shows which one to move first. Always call this for cash-constraint intents BEFORE recommending a specific action — never guess across plans yourself.",
    input_schema: {
      type: "object",
      properties: {
        constraint: {
          type: "string",
          description:
            "Optional short label of what the user said (e.g. 'short this month'). Doesn't affect the math, just tells the policy engine why triage was requested.",
        },
      },
    },
  },
  {
    name: "servicing_refund_case",
    description:
      "Open a refund case for an existing loan. Affirm doesn't issue refunds — the merchant does — but Affirm pauses autopay during the refund window and adjusts the loan principal once the refund posts. Returns a structured case card with merchant contact deep-link and what happens to the loan. Call this when the user says 'I need a refund', 'refund my X', 'I want to return X', etc.",
    input_schema: {
      type: "object",
      properties: {
        loan_id: { type: "string" },
        merchant_hint: {
          type: "string",
          description:
            "Merchant name substring (Peloton, Nike, Marriott).",
        },
      },
    },
  },
  {
    name: "servicing_optimization_options",
    description:
      "Cross-plan optimizer for hypothetical extra cash. Use when the user describes having an EXTRA dollar amount to allocate ('I have an extra $500', 'I just got a bonus, where should it go', 'where should I put $200', 'what should I pay off first', 'how should I use this windfall'). Returns three goal-framed options ranked by strategy: save the most on interest (highest-APR plan), clear a plan today (smallest-balance plan that fits), and free near-term cash (soonest-due plan). Each option shows the dollar impact + a rationale so the user can pick by goal, not by guessing. The Manage tab cannot do this — it shows balances and APRs separately but cannot rank allocation by intent. Always call this for extra-cash intents BEFORE recommending a single plan; never reason across plans yourself.",
    input_schema: {
      type: "object",
      properties: {
        amount_usd: {
          type: "number",
          description:
            "Dollar amount the user wants to allocate. If the user named an explicit number, pass it. If they were vague ('extra cash'), omit and the engine uses a reasonable default.",
        },
      },
    },
  },
];

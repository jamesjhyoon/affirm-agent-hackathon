export type DemoProduct = {
  id: string;
  merchant: string;
  title: string;
  price: number;
  imageUrl: string;
  url: string;
  description: string;
};

export type ActivePlan = {
  id: string;
  merchant: string;
  merchantDomain: string;
  balance: number;
  monthlyPayment: number;
  termMonthsRemaining: number;
  /** Display string in chat cards */
  nextPaymentDate: string;
  /** ISO date for servicing mock engine */
  nextPaymentDueISO: string;
  /** Optional fixed payoff quote for demos. If absent, computed from balance. */
  payoffQuoteUsd?: number;
  /** Days past original due that reschedule is allowed (slide window) */
  rescheduleMaxDaysFromDue?: number;
  /** How many reschedules the user has already used this billing cycle */
  reschedulesUsedThisCycle?: number;
  /** Refund-relevant purchase context for the refund_case tool */
  purchase?: {
    productTitle: string;
    purchasedISO: string;
    purchasedLabel: string;
  };
};

/**
 * Plans the user has already settled. They appear in the Manage tab's
 * Completed section and exist purely to make the account history feel like
 * a real Affirm account — judges shouldn't see a single "no completed
 * plans yet" empty state when they tap Completed. These are READ-ONLY:
 * no overrides apply to them, the agent can't act on them, and the
 * servicing engine never returns them as candidates.
 *
 * Kept structurally distinct from ActivePlan because the affordances differ:
 * no nextPaymentDueISO, no rescheduleMaxDaysFromDue, no purchase context
 * needed (refunds aren't on the table for closed loans).
 */
export type CompletedPlan = {
  id: string;
  merchant: string;
  merchantDomain: string;
  /** Original financed amount when the plan was opened. */
  originalAmount: number;
  monthlyPayment: number;
  /** Total term length, e.g. 12 for a 12-month plan. */
  originalTermMonths: number;
  /** ISO date the plan reached zero balance. */
  paidOffISO: string;
  /**
   * "scheduled" → ran to term on the regular monthly schedule.
   * "early"     → user paid off ahead of schedule (Affirm shows this with
   *               a slightly different chip in the real app).
   */
  payoffMethod: "scheduled" | "early";
  productTitle: string;
};

export type DemoUser = {
  id: string;
  firstName: string;
  availableCredit: number;
  activePlans: ActivePlan[];
  completedPlans: CompletedPlan[];
};

/**
 * Demo dates anchor to "today" computed ONCE at module load. Within a Lambda
 * instance lifetime (and therefore within any single user session) every
 * tool call and UI render sees the SAME ANCHOR_ISO, which is what kept the
 * LLM from drifting between turns ("Apr 28" then "May 2"). Across days the
 * anchor naturally rolls forward, so the demo doesn't go stale.
 *
 * The only failure mode is two simultaneous requests landing on two cold
 * Lambdas that span midnight UTC — vanishingly rare during a live demo, and
 * the worst case is an off-by-one day label on an unrelated request.
 *
 * Plan policy is uniform: 14-day reschedule window, max 1 reschedule per
 * billing cycle. Eligibility contrast in the demo comes from plan STATE
 * (Nike already used its reschedule this cycle → denied) not from per-plan
 * window variance. This makes the rule story consistent regardless of which
 * loan the user asks about.
 */

function deriveAnchorIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

const ANCHOR_ISO = deriveAnchorIso();

function isoPlusDays(isoBase: string, days: number): { iso: string; label: string } {
  const d = new Date(`${isoBase}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return {
    iso: d.toISOString().slice(0, 10),
    label: d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
  };
}

const PELOTON_DUE = isoPlusDays(ANCHOR_ISO, 6);
const NIKE_DUE = isoPlusDays(ANCHOR_ISO, 4);
const MARRIOTT_DUE = isoPlusDays(ANCHOR_ISO, 9);
const PELOTON_PURCHASED = isoPlusDays(ANCHOR_ISO, -180);
const NIKE_PURCHASED = isoPlusDays(ANCHOR_ISO, -22);
const MARRIOTT_PURCHASED = isoPlusDays(ANCHOR_ISO, -75);

const RESCHEDULE_WINDOW_DAYS = 14;
const MAX_RESCHEDULES_PER_CYCLE = 1;

export const RESCHEDULE_POLICY = {
  windowDays: RESCHEDULE_WINDOW_DAYS,
  maxPerCycle: MAX_RESCHEDULES_PER_CYCLE,
};

export const DEMO_USER: DemoUser = {
  id: "user_demo_james",
  firstName: "James",
  availableCredit: 1200,
  activePlans: [
    {
      id: "plan_peloton",
      merchant: "Peloton",
      merchantDomain: "onepeloton.com",
      balance: 842,
      monthlyPayment: 78,
      termMonthsRemaining: 11,
      nextPaymentDate: PELOTON_DUE.label,
      nextPaymentDueISO: PELOTON_DUE.iso,
      rescheduleMaxDaysFromDue: RESCHEDULE_WINDOW_DAYS,
      reschedulesUsedThisCycle: 0,
      purchase: {
        productTitle: "Peloton Bike+",
        purchasedISO: PELOTON_PURCHASED.iso,
        purchasedLabel: PELOTON_PURCHASED.label,
      },
    },
    {
      id: "plan_nike",
      merchant: "Nike",
      merchantDomain: "nike.com",
      balance: 412,
      monthlyPayment: 63.12,
      termMonthsRemaining: 6,
      nextPaymentDate: NIKE_DUE.label,
      nextPaymentDueISO: NIKE_DUE.iso,
      rescheduleMaxDaysFromDue: RESCHEDULE_WINDOW_DAYS,
      // ALREADY rescheduled this cycle → next reschedule attempt is denied.
      // This is the "approved vs denied" demo moment: same intent, different
      // outcome, driven by plan state instead of per-plan window config.
      reschedulesUsedThisCycle: 1,
      purchase: {
        productTitle: "Nike Pegasus 41 Running Shoes",
        purchasedISO: NIKE_PURCHASED.iso,
        purchasedLabel: NIKE_PURCHASED.label,
      },
    },
    {
      id: "plan_marriott",
      merchant: "Marriott",
      merchantDomain: "marriott.com",
      balance: 1380,
      monthlyPayment: 121.04,
      termMonthsRemaining: 12,
      nextPaymentDate: MARRIOTT_DUE.label,
      nextPaymentDueISO: MARRIOTT_DUE.iso,
      rescheduleMaxDaysFromDue: RESCHEDULE_WINDOW_DAYS,
      reschedulesUsedThisCycle: 0,
      purchase: {
        productTitle: "Marriott — 4 nights, Maui",
        purchasedISO: MARRIOTT_PURCHASED.iso,
        purchasedLabel: MARRIOTT_PURCHASED.label,
      },
    },
  ],
  /**
   * Completed-loan history. Picked to feel like a believable two-year-old
   * Affirm account: a mix of small (Allbirds), medium (Wayfair, Best Buy),
   * and large (Casper) purchases, with at least one early-payoff so the
   * Completed tab shows both pill variants. Merchants are deliberately
   * different from the active set so judges don't think "didn't they pay
   * Nike off too?" mid-demo.
   *
   * Dates anchor off ANCHOR_ISO so the spacing stays consistent as the
   * demo rolls forward across days.
   */
  completedPlans: [
    {
      id: "plan_casper_done",
      merchant: "Casper",
      merchantDomain: "casper.com",
      originalAmount: 1295,
      monthlyPayment: 108.0,
      originalTermMonths: 12,
      paidOffISO: isoPlusDays(ANCHOR_ISO, -52).iso,
      payoffMethod: "early",
      productTitle: "Casper Original Mattress (Queen)",
    },
    {
      id: "plan_wayfair_done",
      merchant: "Wayfair",
      merchantDomain: "wayfair.com",
      originalAmount: 624,
      monthlyPayment: 52.0,
      originalTermMonths: 12,
      paidOffISO: isoPlusDays(ANCHOR_ISO, -118).iso,
      payoffMethod: "scheduled",
      productTitle: "Sectional sofa",
    },
    {
      id: "plan_bestbuy_done",
      merchant: "Best Buy",
      merchantDomain: "bestbuy.com",
      originalAmount: 899,
      monthlyPayment: 75.0,
      originalTermMonths: 12,
      paidOffISO: isoPlusDays(ANCHOR_ISO, -214).iso,
      payoffMethod: "scheduled",
      productTitle: "65\" OLED TV",
    },
    {
      id: "plan_allbirds_done",
      merchant: "Allbirds",
      merchantDomain: "allbirds.com",
      originalAmount: 135,
      monthlyPayment: 33.75,
      originalTermMonths: 4,
      paidOffISO: isoPlusDays(ANCHOR_ISO, -340).iso,
      payoffMethod: "scheduled",
      productTitle: "Wool Runners",
    },
  ],
};

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    id: "prod_peloton_bike_plus",
    merchant: "Peloton",
    title: "Peloton Bike+",
    price: 2495,
    imageUrl:
      "https://images.pelotoncdn.com/prod/bike-plus-hero.jpg",
    url: "https://www.onepeloton.com/bike-plus",
    description:
      "Premium indoor cycling bike with rotating HD touchscreen and auto-resistance.",
  },
  {
    id: "prod_casper_original",
    merchant: "Casper",
    title: "Casper Original Mattress (Queen)",
    price: 1295,
    imageUrl:
      "https://images.casper.com/prod/original-queen.jpg",
    url: "https://casper.com/mattresses/original",
    description:
      "Award-winning memory foam mattress with zoned support and breathable top layer.",
  },
  {
    id: "prod_allbirds_wool_runners",
    merchant: "Allbirds",
    title: "Allbirds Wool Runners",
    price: 110,
    imageUrl:
      "https://images.allbirds.com/prod/wool-runners.jpg",
    url: "https://allbirds.com/products/wool-runners",
    description:
      "Sustainable everyday sneakers made from merino wool.",
  },
  {
    id: "prod_allbirds_tree_dasher",
    merchant: "Allbirds",
    title: "Allbirds Tree Dasher",
    price: 135,
    imageUrl:
      "https://images.allbirds.com/prod/tree-dasher.jpg",
    url: "https://allbirds.com/products/tree-dasher",
    description: "Lightweight running shoe made from eucalyptus tree fiber.",
  },
  {
    id: "prod_peloton_tread",
    merchant: "Peloton",
    title: "Peloton Tread",
    price: 2995,
    imageUrl: "https://images.pelotoncdn.com/prod/tread-hero.jpg",
    url: "https://www.onepeloton.com/tread",
    description:
      "Premium treadmill with 23.8\" HD touchscreen and expert-led running classes.",
  },
];

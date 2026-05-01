/**
 * Public architecture artifact for the hackathon demo.
 *
 * This page exists so a judge can answer four questions during or after the
 * demo without having to read the source:
 *   1. Why isn't this just a smarter Manage tab?           → "Scope" + "What the agent does that Manage can't"
 *   2. What would it take to actually ship this?          → "API surface map" + "Time-to-prod cut"
 *   3. Is the cycle-limit denial adverse action under Reg B? → "Compliance stance"
 *   4. Is the Face ID step in the demo real?              → "Demo honesty: simulated vs real WebAuthn"
 *
 * Linked from the Plans tab footer so it's reachable mid-demo.
 *
 * Intentionally a static server component — no auth, no data fetching.
 * If we ever expose anything user-specific here it should move behind auth.
 */

import Link from "next/link";
import evalsResults from "@/evals/results.json";
import evalsPrompts from "@/evals/prompts.json";

type EvalsResults = {
  status?: string;
  ranAt: string | null;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  byCategory: Array<{
    category: string;
    total: number;
    passed: number;
    passRate: number;
  }>;
};

type EvalsPrompts = {
  categories: Record<string, string>;
};

const EVALS_RESULTS = evalsResults as EvalsResults;
const EVALS_PROMPTS = evalsPrompts as EvalsPrompts;

export const metadata = {
  title: "About this build · Affirm Servicing Assistant",
  description:
    "Architecture, scope, compliance stance, and time-to-prod cut for the Affirm Servicing Assistant hackathon prototype.",
};

const ACCENT = "#6959F8";
const NAVY = "#0A2540";

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-white text-[#0A2540]">
      <header
        className="px-6 pt-10 pb-12 text-white"
        style={{
          background: `linear-gradient(135deg, ${NAVY} 0%, #11236A 50%, ${ACCENT} 100%)`,
        }}
      >
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-widest opacity-80 font-semibold">
            Affirm Hackathon · Architecture & Scope
          </div>
          <h1 className="text-[34px] font-bold leading-tight mt-2 tracking-tight">
            Affirm Servicing Assistant
          </h1>
          <p className="text-[16px] opacity-95 mt-3 leading-snug max-w-2xl">
            The Affirm Assistant graduates from giving instructions to taking
            actions — bounded to plan servicing, gated by deterministic
            policy, authorized with Face ID.
          </p>
          <div className="mt-5 flex gap-2 flex-wrap">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-4 py-2 rounded-full bg-white text-[#0A2540] hover:bg-gray-100 transition"
            >
              <span>Open the demo</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-12">
        {/*
         * Opener pullquote — direct quotes from the LIVE Affirm app's
         * Assistant when asked "what can you do?" in May 2026. We use
         * the production assistant's own words to establish the gap
         * before pitching anything. Every section below answers
         * something on this list.
         */}
        <ProductionAssistantQuote />

        <Section
          eyebrow="The bet"
          title="Bounded agency, deterministic policy, biometric authorization."
          body={[
            "Today's chatbot tells you how to do things. This one does them. The agent routes intent; a policy engine decides eligibility; a deterministic executor runs the action — and the user authorizes with a real Face ID step that the LLM never sees.",
            "The whole architecture only makes sense for narrow, policy-bounded actions. That's why this build is scoped to existing-plan servicing and not the open-ended Assistant.",
          ]}
        />

        <CapabilityGapSection />

        <Section
          eyebrow="Scope"
          title="Four actions on existing plans. Nothing else."
          body={[
            "Pay off a loan in full. Reschedule the next payment. Pay an extra installment now. Open a refund case (handoff to merchant + autopay pause).",
            "Plus one cross-plan reasoning move that funnels into one of those four — \"I'm short this month, what are my options?\" — which is the entire reason a chat surface beats a structured tab here.",
          ]}
          callout={{
            label: "Out of scope on purpose",
            text:
              "Shopping, product recommendations, credit-related questions, account closure, dispute initiation, autopay enrollment changes, debit card updates. Each would either widen the executor's blast radius or open Reg B / Reg E surface area without a clear v1 win.",
          }}
        />

        <Section
          eyebrow="Why not just the Manage tab"
          title="Three things Manage structurally can't do."
          body={[
            "Manage tab can show every loan, sort it, filter it, badge it. Three asymmetries justify a conversational surface on top of that:",
          ]}
        >
          <ol className="list-decimal pl-5 mt-3 space-y-2.5 text-[14px] text-[#0A2540] leading-relaxed">
            <li>
              <span className="font-semibold">Cross-plan reasoning under a goal.</span>{" "}
              {"\"I'm going to be short this month\" requires reading every plan's state, checking per-plan cycle usage, sorting by leverage, and recommending a specific move. Manage shows state. The agent computes a decision over state."}
            </li>
            <li>
              <span className="font-semibold">Intent disambiguation in one sentence.</span>{" "}
              {"\"Move my Nike payment\" — is that this month, all future payments, or the autopay schedule? Manage forces the user through three screens to disambiguate. The agent resolves it from a sentence."}
            </li>
            <li>
              <span className="font-semibold">Dead-end → action conversion.</span>{" "}
              {"When Manage hits \"not allowed,\" the journey ends. The agent's denial path explains why, surfaces what is eligible, and offers an alternative inline — turning a self-serve limit into a completed task."}
            </li>
          </ol>
          <p className="mt-4 text-[14px] text-[#3a4a64] leading-relaxed">
            <span className="font-semibold text-[#0A2540]">Where it lives.</span>{" "}
            One conversational surface, surfaced at the app shell (top-right
            chat icon, inbound from notifications, deep-linked from Plans-tab
            rows). The tool registry is bounded — only the four servicing
            primitives today. New capabilities (autopay enrollment, disputes,
            card management) are net-new tools, not a net-new agent.
          </p>
        </Section>

        <Section
          eyebrow="Trust architecture"
          title="LLM router → policy engine → biometric executor → comms"
          body={[
            "1. The LLM is a router. Given an intent, it picks one of four read-only quote/preview tools. It never decides amounts, dates, or eligibility.",
            "2. The policy engine is deterministic. RESCHEDULE_POLICY (14-day window, 1 reschedule per cycle) lives in code, not in the prompt. Cycle-limit denial is computed from plan state, not LLM judgment.",
            "3. The executor is gated by an action-bound WebAuthn assertion. The user's Face ID prompt is keyed to the exact (action, amount, date, loan_id) hash. The LLM cannot reach the executor — only the user's Confirm tap can.",
            "4. Comms run server-side off the executor result, not the chat transcript. In production these would route through Affirm's templated comms pipeline, not Resend.",
            "5. The LLM endpoint itself is configurable via env vars (LLM_BASE_URL, LLM_API_KEY, LLM_DEFAULT_HEADERS_JSON). A v1 production migration would point the chat route at an Affirm-internal AI gateway or proxy WITHOUT a code change — keeping LLM traffic on a sanctioned pipe is a deploy-time config decision, not a rewrite.",
          ]}
        />

        <Section
          eyebrow="API surface map"
          title="What exists, what needs building, who owns it"
          body={[
            "Time-to-prod hinges on which servicing capabilities Affirm already exposes as callable APIs vs which are still UI-only. Best-guess cut from outside the Servicing org:",
          ]}
        >
          <table className="w-full text-[13px] mt-4 border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 font-semibold">Action</th>
                <th className="py-2 pr-3 font-semibold">Today</th>
                <th className="py-2 pr-3 font-semibold">To ship</th>
                <th className="py-2 font-semibold">Owner</th>
              </tr>
            </thead>
            <tbody className="text-[#0A2540]">
              <ApiRow
                action="Payoff quote"
                today="Exposed via servicing-internal API; surfaced in the existing 'Pay early' UI."
                build="Add quote-only endpoint with idempotency key + good-through TTL. Confirm same numbers come back as the UI shows today."
                owner="Servicing"
              />
              <ApiRow
                action="Payoff execute"
                today="Triggered from Plans → Pay early → Confirm; runs through existing payment auth."
                build="Add action-bound WebAuthn assertion verification on the server. Wire idempotency key."
                owner="Servicing + Identity"
              />
              <ApiRow
                action="Reschedule preview"
                today="Eligibility runs in the rescheduling UI; not callable as a primitive."
                build="Pull preview into a standalone API that returns blocked_request codes (RSH-CYCLE_LIMIT, RSH-MAX_WINDOW, RSH-PAST). Single source of truth across UI and agent."
                owner="Servicing"
              />
              <ApiRow
                action="Reschedule execute"
                today="Internal rescheduling pipeline exists."
                build="Action-bound WebAuthn + idempotency. Same path as today's UI; new entry point."
                owner="Servicing + Identity"
              />
              <ApiRow
                action="Pay extra installment"
                today="Available in 'Pay early' flow."
                build="API parity + WebAuthn gate."
                owner="Servicing + Identity"
              />
              <ApiRow
                action="Refund case + autopay pause"
                today="Manual via support today; merchant feedback loop exists for some MIDs."
                build="Programmatic case open + temporary autopay suspension with a max-duration timer + auto-revert if merchant doesn't confirm."
                owner="Servicing + Merchant Ops + Comms"
              />
            </tbody>
          </table>
        </Section>

        <Section
          eyebrow="Compliance stance"
          title="Servicing UX, not credit decisioning."
          body={[
            "Reschedule denials are a SERVICING POLICY result, not a credit decision. \"You've already used your one reschedule this billing cycle\" is the same shape as \"you've already used your free transfer this month\" on a deposit account — operational limit, not adverse action under Reg B / ECOA.",
            "The 1-per-cycle / 14-day policy is hardcoded in the demo for determinism. In production it would be sourced from Affirm's existing servicing rules engine — same numbers the existing rescheduling UI uses. The agent doesn't invent the policy; it surfaces a policy result.",
            "The agent stays out of credit-related questions entirely. \"Can I get a higher Affirm limit?\" or \"Why was I declined at checkout?\" route to a one-line deflection, not to a tool. Those touch Reg B and need a human / a regulated decisioning path.",
            "Auditability: every executor call returns a reference_id. In production those write to the same servicing audit log as today's UI-driven actions, with the addition of the action-bound WebAuthn assertion ID for non-repudiation.",
          ]}
        />

        <Section
          eyebrow="Demo honesty"
          title="What's real, what's simulated, where the line is."
          body={[
            "The architecture is real: deterministic policy engine, action-bound WebAuthn challenge/assertion code, server-side executor isolated from the LLM, signed challenge cookies, hashed action binding. All of it is in the repo.",
          ]}
        >
          <div className="mt-4 grid sm:grid-cols-2 gap-3">
            <HonestyCard
              kind="real"
              title="Real in the demo"
              bullets={[
                "LLM-as-router with tool-only access to read-only previews.",
                "Policy engine computes amounts, dates, and blocked_request codes deterministically.",
                "Server-side executor; LLM cannot reach it.",
                "@affirm.com Google sign-in gates the entire app.",
                "Action mutations land in the user's session via NextAuth JWT updates and reflect on the Plans tab.",
              ]}
            />
            <HonestyCard
              kind="sim"
              title="Simulated in the demo"
              bullets={[
                "The Face ID step on Confirm — a 1.5s spinner standing in for the OS biometric prompt. Real WebAuthn requires a platform authenticator that most laptop browsers in a hackathon room don't have.",
                "Servicing data — three deterministic mock loans (Peloton, Nike, Marriott). Nike has its 1-per-cycle reschedule already used to drive the approved-vs-denied contrast.",
                "Email comms — Resend in dev. Production would route through Affirm's templated, legally-reviewed comms pipeline.",
              ]}
            />
          </div>
          <p className="mt-4 text-[13px] text-gray-600 leading-relaxed">
            The full real-WebAuthn path is intact in the codebase: registration, challenge cookie, action-bound auth token, server-verified assertion. The demo's <code className="text-[12px] bg-gray-100 px-1 py-0.5 rounded">/api/servicing/execute-demo</code> endpoint exists only to bypass the platform-authenticator requirement on a laptop. Production iOS would call <code className="text-[12px] bg-gray-100 px-1 py-0.5 rounded">/api/servicing/execute</code> with a real assertion. The LLM still cannot reach either endpoint; the user's explicit Confirm tap is the only caller.
          </p>
        </Section>

        <Section
          eyebrow="Eval suite"
          title="Routing, scope, and adversarial coverage."
          body={[
            "A 39-prompt regression set lives at evals/prompts.json. The runner sends each prompt to the production system prompt and tool definitions, captures the first tool_use block, and asserts on tool name, arg shape, and forbidden text. The production chat route and the eval suite import the EXACT same prompt template and tool schemas — there's no drift between what the demo runs and what the tests cover.",
            "What the suite tests:",
          ]}
        >
          <ul className="mt-3 space-y-2 text-[13px] text-[#3a4a64] leading-relaxed">
            {Object.entries(EVALS_PROMPTS.categories).map(([cat, desc]) => (
              <li key={cat} className="flex gap-2">
                <span className="font-mono text-[12px] text-[#0A2540] font-semibold shrink-0 mt-[1px]">
                  {cat}
                </span>
                <span>·</span>
                <span>{desc}</span>
              </li>
            ))}
          </ul>

          <EvalSuiteSummary results={EVALS_RESULTS} />

          <p className="mt-4 text-[12px] text-gray-500 leading-relaxed">
            The runner is{" "}
            <code className="bg-gray-100 px-1 py-0.5 rounded text-[11.5px]">
              npm run evals
            </code>{" "}
            (sequential, ~2-4 minutes for 39 prompts at ~$0.30 per run). In a
            shipped v1 this would gate every prompt change in CI; new tools or
            new scope adjustments add new tests before they ship.
          </p>
        </Section>

        <Section
          eyebrow="Time-to-prod cut"
          title="What it would take to ship a real v1."
          body={[]}
        >
          <ol className="list-decimal pl-5 mt-4 space-y-2 text-[14px] text-[#0A2540] leading-relaxed">
            <li><span className="font-semibold">Servicing API parity (4 actions).</span> Quote, preview, execute primitives exposed through Affirm's existing servicing services. Idempotency keys end-to-end. Owner: Servicing.</li>
            <li><span className="font-semibold">WebAuthn integration with current auth.</span> Action-bound assertion verification wired into the same identity stack that gates today's Pay early flow. Owner: Identity + Security.</li>
            <li><span className="font-semibold">Comms pipeline integration.</span> Replace Resend with Affirm's templated comms service; legal review of any new templates. Owner: Comms + Legal.</li>
            <li><span className="font-semibold">Audit + observability.</span> Every executor call writes to the existing servicing audit log with the WebAuthn assertion ID for non-repudiation. Telemetry on intent classification accuracy + tool call success.</li>
            <li><span className="font-semibold">Scope guardrails.</span> Hardened system prompt + tool whitelist; load tests for prompt injection from refund case descriptions; eval set covering same-intent / different-state contrasts. Owner: Agent platform.</li>
            <li><span className="font-semibold">Experiment design.</span> Statsig rollout: agent-completion rate, repeat-contact rate within 24h, downstream support deflection, $-recovered on early payoff. Baseline against today's chatbot containment rate.</li>
          </ol>
        </Section>

        <Section
          eyebrow="Risks we're sized to"
          title="What can go wrong, what we'd do about it."
          body={[]}
        >
          <ul className="mt-4 space-y-3 text-[14px] leading-relaxed">
            <RiskItem
              risk="ATO replay"
              mitigation="Action-bound WebAuthn assertions (the assertion is keyed to a hash of the exact action params, so a stolen assertion can't be replayed against a different amount or loan). Velocity limits on reschedule + payoff per session."
            />
            <RiskItem
              risk="LLM intent misclassification"
              mitigation="Tool whitelist (the agent has 5 tools, not 50). Eval set with adversarial intents. Default to deflect when confidence is low, never hallucinate an action."
            />
            <RiskItem
              risk="Hallucinated amounts/dates"
              mitigation="Tools return strings the LLM is instructed to copy verbatim. UI cards render directly from tool output, not from LLM text — the user sees the structured truth even if the LLM paraphrases."
            />
            <RiskItem
              risk="Refund flow stuck pending merchant confirmation"
              mitigation="Autopay-pause has a max-duration timer with auto-revert + user notification. Surfaced as a real SLA in the refund card, not a soft promise."
            />
            <RiskItem
              risk="Cost at scale"
              mitigation="Tool routing keeps token usage bounded; most turns are 1-2 tool calls. Per-action LLM cost should stay well under the support deflection it replaces, but is part of the experiment readout."
            />
          </ul>
        </Section>

        <Section
          eyebrow="What to read next in the source"
          title="If you want the architecture, not the marketing."
          body={[]}
        >
          <ul className="mt-4 space-y-2 text-[13px] text-[#0A2540] leading-relaxed">
            <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-[12px]">app/lib/servicing.ts</code> — policy engine; deterministic amounts/dates/eligibility.</li>
            <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-[12px]">app/lib/servicing-executor.ts</code> — server-side executor; LLM cannot reach it.</li>
            <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-[12px]">app/lib/webauthn.ts</code> — action-bound challenge + assertion utilities (real, used in the production path).</li>
            <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-[12px]">app/api/servicing/execute/route.ts</code> — production execute path; verifies assertion before calling executor.</li>
            <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-[12px]">app/api/servicing/execute-demo/route.ts</code> — demo-only path; documented at top of file why it exists.</li>
            <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-[12px]">app/api/chat/route.ts</code> — system prompt + tool dispatch; scope rules live here.</li>
          </ul>
        </Section>

        <footer className="pt-8 pb-4 border-t border-gray-100 text-[12px] text-gray-400">
          Hackathon prototype — not affiliated with Affirm production systems.
          Built to demonstrate an architectural pattern, not to handle real
          money.
        </footer>
      </main>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  body,
  callout,
  children,
}: {
  eyebrow: string;
  title: string;
  body: string[];
  callout?: { label: string; text: string };
  children?: React.ReactNode;
}) {
  return (
    <section>
      <div className="text-[11px] uppercase tracking-widest font-semibold" style={{ color: ACCENT }}>
        {eyebrow}
      </div>
      <h2 className="text-[22px] font-bold mt-1.5 tracking-tight leading-tight">
        {title}
      </h2>
      {body.map((p, i) => (
        <p key={i} className="text-[14px] mt-3 text-[#3a4a64] leading-relaxed">
          {p}
        </p>
      ))}
      {callout && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide font-bold text-amber-800">
            {callout.label}
          </div>
          <div className="text-[13px] text-amber-900 mt-1 leading-snug">
            {callout.text}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}

function ApiRow({
  action,
  today,
  build,
  owner,
}: {
  action: string;
  today: string;
  build: string;
  owner: string;
}) {
  return (
    <tr className="align-top border-b border-gray-100">
      <td className="py-3 pr-3 font-semibold text-[13px]">{action}</td>
      <td className="py-3 pr-3 text-[12.5px] text-[#3a4a64] leading-snug">{today}</td>
      <td className="py-3 pr-3 text-[12.5px] text-[#3a4a64] leading-snug">{build}</td>
      <td className="py-3 text-[12px] text-gray-500 whitespace-nowrap">{owner}</td>
    </tr>
  );
}

function HonestyCard({
  kind,
  title,
  bullets,
}: {
  kind: "real" | "sim";
  title: string;
  bullets: string[];
}) {
  const tone =
    kind === "real"
      ? { border: "border-emerald-200", bg: "bg-emerald-50", chip: "bg-emerald-100 text-emerald-800" }
      : { border: "border-amber-200", bg: "bg-amber-50", chip: "bg-amber-100 text-amber-800" };
  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg} px-4 py-3`}>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded ${tone.chip}`}>
          {kind === "real" ? "Real" : "Simulated"}
        </span>
        <span className="text-[13px] font-semibold text-[#0A2540]">{title}</span>
      </div>
      <ul className="mt-2 space-y-1.5 text-[12.5px] text-[#3a4a64] leading-snug">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="opacity-60 mt-[2px]">·</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvalSuiteSummary({ results }: { results: EvalsResults }) {
  const notRun = results.status === "not_yet_executed" || !results.ranAt;
  const ratePct = Math.round(results.passRate * 100);
  const lastRunLabel = results.ranAt
    ? new Date(results.ranAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "never";

  return (
    <div className="mt-5 rounded-2xl border border-gray-200 overflow-hidden">
      <div
        className="px-4 py-3"
        style={{
          background: notRun
            ? "linear-gradient(135deg, #6b7280 0%, #4b5563 100%)"
            : ratePct >= 90
            ? "linear-gradient(135deg, #0f7a4e 0%, #16a870 100%)"
            : ratePct >= 70
            ? "linear-gradient(135deg, #b45309 0%, #f59e0b 100%)"
            : "linear-gradient(135deg, #991b1b 0%, #dc2626 100%)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wide opacity-80 font-semibold text-white">
          Latest run
        </div>
        <div className="flex items-baseline gap-2 mt-0.5 text-white">
          {notRun ? (
            <>
              <span className="text-[20px] font-bold leading-tight">
                Awaiting first run
              </span>
              <span className="text-[12px] opacity-90">
                {results.total} tests staged
              </span>
            </>
          ) : (
            <>
              <span className="text-[28px] font-bold leading-tight">
                {ratePct}%
              </span>
              <span className="text-[13px] opacity-90">
                {results.passed}/{results.total} passing
              </span>
            </>
          )}
        </div>
        {!notRun && (
          <div className="text-[11px] opacity-85 text-white mt-1">
            Last run {lastRunLabel}
          </div>
        )}
      </div>
      <div className="bg-white">
        <table className="w-full text-[12.5px]">
          <tbody>
            {results.byCategory.map((row) => {
              const pct = Math.round(row.passRate * 100);
              const fill = notRun
                ? "bg-gray-200"
                : pct >= 90
                ? "bg-emerald-500"
                : pct >= 70
                ? "bg-amber-500"
                : "bg-red-500";
              return (
                <tr key={row.category} className="border-t border-gray-100">
                  <td className="px-4 py-2 align-middle">
                    <code className="text-[11.5px] text-[#0A2540] font-semibold">
                      {row.category}
                    </code>
                  </td>
                  <td className="px-2 py-2 align-middle w-32">
                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      {!notRun && (
                        <div
                          className={`h-full ${fill}`}
                          style={{ width: `${pct}%` }}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right align-middle whitespace-nowrap text-[#3a4a64]">
                    {row.passed}/{row.total}{" "}
                    <span className="text-gray-400">
                      {notRun ? "" : `· ${pct}%`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Pulled verbatim from the Affirm production app's Assistant when asked
 * "what can you do?" on May 1, 2026. Quoting it directly is stronger
 * than narrating the gap ourselves — these are the production
 * assistant's own admission of what it can't do today.
 */
const PRODUCTION_ASSISTANT_CANNOT = [
  "Make multiple payments in one session",
  "Schedule future payments",
  "Set up AutoPay (but I can guide you how to do it yourself)",
  "Add or remove payment methods (but I can show you how)",
];

const PRODUCTION_ASSISTANT_CAN = [
  "Look up your account information and active payment plans",
  "Help you make a single payment on an active payment plan",
  "Provide information about your payment plans, balances, and due dates",
  "Guide you through making payments on the Affirm website or app",
  "Answer questions about Affirm products and services",
];

function ProductionAssistantQuote() {
  return (
    <section className="rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 px-5 py-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={NAVY} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21" />
          </svg>
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500">
            What the production Affirm Assistant tells users today
          </div>
          <div className="text-[12px] text-gray-500 mt-0.5">
            Verbatim, May 1, 2026, in the live Affirm app
          </div>

          <div className="mt-3 grid sm:grid-cols-2 gap-3">
            <div className="rounded-xl bg-white border border-gray-200 px-3.5 py-3">
              <div className="text-[10px] uppercase tracking-wide font-bold text-gray-500">
                What I can do
              </div>
              <ul className="mt-1.5 space-y-1 text-[12.5px] text-[#3a4a64] leading-snug">
                {PRODUCTION_ASSISTANT_CAN.map((item, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="opacity-50 mt-[2px]">·</span>
                    <span>&ldquo;{item}&rdquo;</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl bg-white border border-gray-200 px-3.5 py-3">
              <div className="text-[10px] uppercase tracking-wide font-bold text-gray-500">
                What I cannot do in this chat
              </div>
              <ul className="mt-1.5 space-y-1 text-[12.5px] text-[#3a4a64] leading-snug">
                {PRODUCTION_ASSISTANT_CANNOT.map((item, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="opacity-50 mt-[2px]">·</span>
                    <span>&ldquo;{item}&rdquo;</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="mt-3.5 text-[13px] text-[#0A2540] leading-relaxed">
            Notice the pattern: every CAN item that involves an action
            ends in &ldquo;guide you,&rdquo; &ldquo;show you how,&rdquo; or
            &ldquo;help you make.&rdquo; The production Assistant is a router
            to UI surfaces. This prototype is a router to actions —
            same intents, executed inline.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Maps each "cannot" the production assistant admits to the
 * corresponding capability in this build. Quotes are exact text from
 * the screenshot — we don't paraphrase Affirm's own product copy.
 */
type CapabilityRow = {
  quote: string;
  status: "missing" | "handoff";
  thisBuild: string;
  scopeNote?: string;
};

const CAPABILITY_ROWS: CapabilityRow[] = [
  {
    quote: "Make multiple payments in one session",
    status: "missing",
    thisBuild:
      "Multi-plan allocation in optimization. Given a dollar amount, ranks strategies — close the most plans, save the most interest, free the most near-term cash — and shows the leg-by-leg apply across plans.",
  },
  {
    quote: "Schedule future payments",
    status: "missing",
    thisBuild:
      "Reschedule with deterministic eligibility check. 14-day window past original due, one reschedule per upcoming payment. Approved and denied paths both render the same card; denied paths surface eligible alternatives inline.",
  },
  {
    quote: "Help you make a single payment on an active payment plan",
    status: "handoff",
    thisBuild:
      "Pay-installment-now executed inline. The user authorizes once with Face ID and the action runs against the executor — no second surface, no second auth, no narration of where to tap.",
  },
  {
    quote: "Guide you through making payments on the Affirm website or app",
    status: "handoff",
    thisBuild:
      "The system prompt explicitly forbids narrating UI navigation. The agent either executes the action or hands off to a servicing rep — never to a screen.",
  },
  {
    quote: "Set up AutoPay (but I can guide you how to do it yourself)",
    status: "handoff",
    thisBuild: "Out of scope in v1.",
    scopeNote:
      "Autopay enrollment touches Reg E and merits a separate executor + comms review. The agent declines explicitly rather than narrating navigation.",
  },
  {
    quote: "Add or remove payment methods (but I can show you how)",
    status: "handoff",
    thisBuild: "Out of scope in v1.",
    scopeNote:
      "Card vault changes are an Identity-owned surface; widening this agent to touch the wallet is a larger blast-radius decision deferred past v1.",
  },
];

function CapabilityGapSection() {
  return (
    <Section
      eyebrow="What changes vs. today"
      title="Production Assistant's own words, mapped to this build."
      body={[
        "Every row is a direct quote from the production Assistant's self-description (above). Two columns: (1) what it admits it can't do, or what it does as a hand-off, and (2) how this prototype handles the same intent.",
      ]}
    >
      <div className="mt-4 space-y-3">
        {CAPABILITY_ROWS.map((row, i) => (
          <CapabilityRowView key={i} row={row} />
        ))}
      </div>
      <p className="mt-5 text-[13px] text-gray-600 leading-relaxed">
        The framing for every action capability in this prototype is
        bounded — four servicing primitives gated by a deterministic
        policy engine and biometric authorization. Out-of-scope items
        stay out of scope explicitly; they are not narrated, deflected
        with a UI walkthrough, or quietly handed off.
      </p>
    </Section>
  );
}

function CapabilityRowView({ row }: { row: CapabilityRow }) {
  const tone =
    row.status === "missing"
      ? { chip: "bg-red-50 text-red-800 border-red-200", label: "Cannot today" }
      : { chip: "bg-amber-50 text-amber-800 border-amber-200", label: "Hand-off today" };
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 px-4 py-2.5 border-b border-gray-200 flex items-start gap-2">
        <span
          className={`text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded border ${tone.chip} shrink-0 mt-[1px]`}
        >
          {tone.label}
        </span>
        <span className="text-[13px] text-[#0A2540] italic leading-snug">
          &ldquo;{row.quote}&rdquo;
        </span>
      </div>
      <div className="px-4 py-3 bg-white">
        <div className="text-[10px] uppercase tracking-wide font-bold text-[#0A2540]">
          This build
        </div>
        <div className="text-[13px] text-[#3a4a64] mt-1 leading-relaxed">
          {row.thisBuild}
        </div>
        {row.scopeNote && (
          <div className="mt-2 text-[12px] text-gray-500 leading-snug border-l-2 border-gray-200 pl-2.5">
            {row.scopeNote}
          </div>
        )}
      </div>
    </div>
  );
}

function RiskItem({ risk, mitigation }: { risk: string; mitigation: string }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-1.5 h-1.5 rounded-full mt-[8px]" style={{ backgroundColor: ACCENT }} />
      <div>
        <div className="font-semibold text-[14px]">{risk}</div>
        <div className="text-[13px] text-[#3a4a64] mt-0.5 leading-relaxed">
          {mitigation}
        </div>
      </div>
    </li>
  );
}

import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFINITIONS, dispatchTool, type ToolContext } from "@/app/lib/tools";
import { auth } from "@/auth";

/**
 * LLM client construction.
 *
 * The chat route hits Anthropic via the official SDK. The SDK accepts a
 * custom baseURL + defaultHeaders, so we expose those as env vars to make
 * the LLM endpoint configurable WITHOUT a code change. That matters for
 * any future migration to an Anthropic-compatible proxy — corporate LLM
 * gateways, internal AI platforms, regional Anthropic deployments — that
 * speak the same request/response schema. Today, this demo points
 * straight at api.anthropic.com.
 *
 * Env-var contract (set at deploy time, never per-request):
 *
 *   LLM_BASE_URL              optional. Override the default Anthropic
 *                             host. Omit for direct Anthropic.
 *   LLM_API_KEY               preferred. Falls back to ANTHROPIC_API_KEY
 *                             for backward compatibility with existing
 *                             local .env files.
 *   LLM_DEFAULT_HEADERS_JSON  optional JSON object of extra headers.
 *                             Useful for proxies that require bearer
 *                             auth ({ "Authorization": "Bearer ..." })
 *                             or cost-attribution metadata
 *                             ({ "X-Team-Id": "..." }).
 *
 * The LLM call is the only place in the codebase that needs to know which
 * endpoint is in play. Keeping it env-driven means a future swap is a
 * deploy-time config change, not a code edit.
 */
function buildLlmClient(): { client: Anthropic; apiKey: string } {
  const baseURL = process.env.LLM_BASE_URL?.trim();
  const apiKey =
    process.env.LLM_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim() ||
    "";

  let defaultHeaders: Record<string, string> | undefined;
  const headersRaw = process.env.LLM_DEFAULT_HEADERS_JSON?.trim();
  if (headersRaw) {
    try {
      const parsed = JSON.parse(headersRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        defaultHeaders = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, v as string])
        );
      }
    } catch (e) {
      console.warn(
        "[chat] LLM_DEFAULT_HEADERS_JSON could not be parsed — ignoring.",
        e
      );
    }
  }

  const client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
  return { client, apiKey };
}

const { client, apiKey: LLM_API_KEY } = buildLlmClient();

function buildSystemPrompt(userFirstName: string) {
  return SYSTEM_PROMPT_TEMPLATE.replace(/{{USER_FIRST_NAME}}/g, userFirstName);
}

const SYSTEM_PROMPT_TEMPLATE = `You are the Affirm Servicing Assistant inside the Affirm app. The logged-in user is {{USER_FIRST_NAME}}.

You exist to help {{USER_FIRST_NAME}} act on their existing Affirm plans. You handle exactly four actions:
1. Pay off an existing loan in full
2. Reschedule the next payment to a different date
3. Pay an extra installment now (typically when a reschedule isn't allowed)
4. Open a refund case for a past purchase (handoff to merchant; Affirm pauses autopay and adjusts principal)

Plus one cross-plan reasoning move that leads INTO one of those actions:
0. Triage when the user describes a cash-flow constraint ("I'm going to be short", "tight on cash", "can't make all my payments", "what are my options", "need to free up cash", "running low this month"). For these intents you call servicing_triage_options FIRST so the user sees every plan's eligibility before they pick. The Manage tab in the app cannot do this — only you can reason across plans + policy at once.

You are NOT a shopping assistant. You do NOT help users find products, browse merchants, recommend things to buy, search the catalog, initiate purchases, or suggest "shop for something new." NEVER end a reply with an offer to help shop, browse, or look at deals — even after a balance lookup. Plan management is the entire scope.

If the user asks for ANYTHING outside the four actions above, respond with a one-sentence deflection — for example: "I'm focused on managing your existing Affirm plans right now — I can help you pay off, reschedule, pay early, or start a refund." Then stop.

CRITICAL — how authorization works:
You do NOT execute servicing actions yourself. You only call the read-only quote/preview tools. The QUOTE/PREVIEW CARD that the UI renders has a built-in "Confirm with Face ID" button. The user taps it; the OS prompts for Face ID; the deterministic servicing engine runs the action and the success card appears. You should NEVER ask the user to type a confirmation token, paste a code, or "say PAY" — the Face ID prompt is the authorization. You will NOT see the execute happen and will NOT need to issue any execute call.

Read-only tools (amounts, dates, and eligibility come from tools, NEVER from your reasoning):
- servicing_triage_options: cross-plan triage. Call FIRST for any cash-constraint intent (see action 0 above). The card shows every plan sorted by due date with per-plan reschedule eligibility plus a deterministic recommendation. After it returns, frame the recommendation in one or two sentences ("Your soonest reschedule-eligible payment is Peloton — $78 due May 5. Want me to move it?") and let the user respond. Do NOT skip to a per-plan tool yourself; the user picks.
- servicing_payoff_quote: get the payoff amount + funding sources for a loan. Pass merchant_hint (Peloton / Nike / Marriott). The UI card has the Face ID button.
- servicing_reschedule_preview: show allowed reschedule dates and the policy outcome. Pass merchant_hint AND requested_date_iso (YYYY-MM-DD) whenever the user named a specific date or relative time ("2 weeks out", "next payday", "June 10"). Passing requested_date_iso is what makes the deterministic policy engine fire.
- servicing_refund_case: open a refund case. Returns a structured card with merchant deep-link and what happens to the loan. Use this for any "I need a refund", "I want to return X", "refund my Nike order" intent.
- check_affirm_capacity: ONLY when the user is genuinely ambiguous about which loan ("manage my plans", "what do I owe"). Do NOT use as a "first step" for servicing intents.

Other tools in the codebase but you must IGNORE entirely: list_merchants, search_products, calculate_affirm_terms, execute_purchase.

Servicing flow rules:
- For cash-constraint intents (action 0): call servicing_triage_options FIRST, then frame the deterministic recommendation in plain language. The card surfaces every plan + eligibility; your job is one or two short sentences pointing at the recommended action and asking the user to confirm.
- For "pay off my X / reschedule X / pay X early / refund X" — call the matching tool IMMEDIATELY with merchant_hint=X. No preamble, no "let me check first." The card the tool returns IS the answer.
- If the user just confirmed a triage recommendation ("yes do it", "yes move Peloton", "go ahead with that"), call the corresponding per-plan tool (servicing_reschedule_preview for reschedule, servicing_payoff_quote for payoff, etc.) using the merchant from the recommendation. If they specify a date in the same turn, pass requested_date_iso.
- Parse natural-language dates into YYYY-MM-DD before passing to servicing_reschedule_preview. ALWAYS pass requested_date_iso when the user names ANY relative or absolute time, including vague ones — that's what makes the policy engine fire and what makes the card pre-select the right chip:
  • "a week out" / "in a week" / "next week" → current_due + 7 days
  • "a few days" / "a couple days" → current_due + 3 days
  • "2 weeks out" / "in 2 weeks" → current_due + 14 days
  • "a month out" → current_due + 30 days
  • "next payday on the 30th" → upcoming 30th of the relevant month
  • "June 10" → the next June 10
  When in doubt, prefer the user's literal interpretation. If the date is past today, ask once.
- COPY DATES AND AMOUNTS VERBATIM FROM TOOL OUTPUT. Cite current_due_label, payoff_usd, next_installment_usd, allowed_reschedule_targets[].label exactly as returned. Do NOT reformat, do NOT round, do NOT compute. If you didn't get a value from a tool, you don't have it.
- NEVER name a specific date in your prose unless that exact date string is present in the tool output (current_due_label, requested_date_label, an entry in allowed_reschedule_targets[].label, latest_eligible_label, or a previously-confirmed executed result). If you computed a date in your head, do NOT mention it — the card already shows the eligible chips. Say "tap a date below" instead. This rule prevents the receipt and your spoken answer from disagreeing.
- The reschedule policy is uniform across plans: 14-day window past original due, 1 reschedule per billing cycle. NEVER claim a "different" window for any specific loan.
- If servicing_reschedule_preview returns blocked_request, acknowledge in one short sentence using the policy CODE and the message text from the tool, then point to the card's pay-early option (or, for RSH-PAST, the eligible date chips). Frame this as a SELF-SERVE channel limit, not a denial — the user can always escalate to a servicing rep. Examples:
  • RSH-CYCLE_LIMIT: "Nike's already been rescheduled this cycle — self-serve allows one per billing cycle. The card has a one-tap option to pay this installment now, or you can talk to a servicing rep for an exception."
  • RSH-MAX_WINDOW: "That's outside the 14-day self-serve window. The card has a one-tap pay-early option, or you can talk to a servicing rep for an exception."
  • RSH-PAST: "May 1 is before your current Peloton due date. The card has eligible dates you can tap — or you can pay this installment now."
  Do NOT call any other tool to "find another date" — the card surfaces the right next step.
- For refund intents: call servicing_refund_case immediately. Then in your one-line message, explain what happens to the loan: "I've opened a refund case with Nike — autopay is paused while they review. Once Nike confirms the refund, your remaining balance will be adjusted automatically."

Voice:
- Warm, confident, concise. Two or three short sentences per turn maximum. Use {{USER_FIRST_NAME}} naturally, not in every sentence.
- PLAIN TEXT ONLY. No markdown of any kind. No **bold**, no *italics*, no _underscores_, no \`backticks\`, no headings, no bullet lists, no numbered lists, no tables, no code blocks, no block quotes.
- The UI renders tool results as native Affirm cards; your job is the short conversational framing around them.
- After surfacing a quote/preview card, end with something like "Tap Confirm with Face ID to authorize." Do NOT mention typing PAY, MOVE, or any other token — that flow is gone.
- After ANY response, if you find yourself about to suggest shopping, deals, browsing, or "anything else I can help with" → STOP. End at the action you offered.

Hackathon note: servicing tools use deterministic policy data for the demo — real shipping would call Affirm's servicing APIs with the same separation (LLM orchestrates intent; WebAuthn biometric step-up authorizes; policy engine decides amounts and eligibility).`;

type ClientMessageInput = { role?: unknown; content?: unknown };

const MAX_CLIENT_MESSAGES = 80;

function validateMessages(raw: unknown): { role: "user" | "assistant"; content: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of raw as ClientMessageInput[]) {
    if (!m || typeof m !== "object") return null;
    if (m.role !== "user" && m.role !== "assistant") return null;
    if (typeof m.content !== "string") return null;
    if (m.content.length > 4000) return null;
    out.push({ role: m.role, content: m.content });
  }
  if (out.length === 0) return null;
  // Soft cap: keep the most recent MAX_CLIENT_MESSAGES turns, preserving a user-first head.
  if (out.length > MAX_CLIENT_MESSAGES) {
    const trimmed = out.slice(out.length - MAX_CLIENT_MESSAGES);
    while (trimmed.length > 0 && trimmed[0].role !== "user") trimmed.shift();
    return trimmed.length > 0 ? trimmed : null;
  }
  return out;
}

type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  | { type: "turn_break" }
  | { type: "done" }
  | { type: "error"; message: string };

export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!email.toLowerCase().endsWith("@affirm.com")) {
    return Response.json(
      { error: "Unauthorized — sign in with your @affirm.com account." },
      { status: 401 }
    );
  }

  if (!LLM_API_KEY) {
    return Response.json(
      {
        error:
          "Server is missing LLM credentials. Set LLM_API_KEY or ANTHROPIC_API_KEY.",
      },
      { status: 500 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const clientMessages = validateMessages(
    (body as { messages?: unknown })?.messages
  );
  if (!clientMessages) {
    return Response.json(
      { error: "Invalid or empty messages payload" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // controller already closed
        }
      };

      try {
        const messages: Anthropic.MessageParam[] = clientMessages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const firstName =
          session?.user?.name?.split(" ")[0] ||
          email.split("@")[0].split(".")[0].replace(/^./, (c) => c.toUpperCase());
        const systemPrompt = buildSystemPrompt(firstName);
        const toolContext: ToolContext = { userEmail: email, firstName };

        const MAX_ITERATIONS = 8;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const response = await runTurn(messages, systemPrompt, emit);

          if (response.stop_reason === "tool_use") {
            const toolUseBlocks = response.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
            );

            messages.push({ role: "assistant", content: response.content });

            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            for (const tu of toolUseBlocks) {
              let result: unknown;
              try {
                result = await dispatchTool(tu.name, tu.input, toolContext);
              } catch (toolErr) {
                console.error(`[tool ${tu.name}]`, toolErr);
                result = {
                  error: `Tool ${tu.name} failed — try again or ask differently.`,
                };
              }
              emit({
                type: "tool_result",
                id: tu.id,
                name: tu.name,
                result,
              });
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: JSON.stringify(result),
              });
            }
            messages.push({ role: "user", content: toolResults });
            emit({ type: "turn_break" });
            continue;
          }

          break;
        }

        emit({ type: "done" });
      } catch (err) {
        console.error("Chat API stream error:", err);
        const message = friendlyError(err);
        emit({ type: "error", message });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401) return "LLM authentication failed — check LLM_API_KEY or ANTHROPIC_API_KEY.";
    if (err.status === 429) return "Rate limited. Give it a few seconds and try again.";
    if (err.status === 529 || err.status === 503)
      return "Claude is overloaded right now. Try again in a moment.";
    return `Upstream error (${err.status ?? "unknown"}). Try again.`;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "Request timed out. Try again.";
  }
  return "Something went wrong on our end. Try again.";
}

async function runTurn(
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  emit: (event: StreamEvent) => void
): Promise<Anthropic.Message> {
  const anthropicStream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: systemPrompt,
    tools: TOOL_DEFINITIONS,
    messages,
  });

  for await (const event of anthropicStream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      emit({ type: "text", delta: event.delta.text });
    } else if (
      event.type === "content_block_start" &&
      event.content_block.type === "tool_use"
    ) {
      emit({
        type: "tool_use",
        id: event.content_block.id,
        name: event.content_block.name,
        input: {},
      });
    }
  }

  return await anthropicStream.finalMessage();
}

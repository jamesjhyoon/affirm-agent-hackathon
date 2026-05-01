"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import {
  authorizeAndExecute,
  AuthorizationError,
} from "./lib/webauthn-client";
import type {
  ServicingActionParams,
  ServicingActionResult,
} from "./lib/servicing-executor";
import type { LoanOverride, LoanView } from "./lib/loans";
import { DEMO_USER, type ActivePlan as DemoActivePlan } from "./lib/mockData";

type AssistantBlock =
  | { kind: "text"; content: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: "running" | "complete";
      result?: unknown;
    }
  /**
   * Synthesized post-biometric block. The LLM does NOT produce these — they
   * are injected client-side after /api/servicing/execute returns. This is
   * how the deterministic execute path stays out of the LLM loop while still
   * showing as a normal assistant message in the chat transcript.
   */
  | { kind: "executed"; result: ServicingActionResult }
  | { kind: "error"; message: string };

/**
 * Per-card lifecycle for the biometric authorization on a quote/preview card.
 * Keyed by tool_use block id so multiple cards in a long conversation can be
 * tracked independently.
 */
type BiometricExecutionState =
  | { phase: "idle" }
  | { phase: "authenticating" } // Touch ID prompt is open
  | { phase: "submitting" } // assertion verified, executing server-side
  | { phase: "done" } // success card has been appended below
  | { phase: "error"; message: string };

type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; blocks: AssistantBlock[] };

type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  | { type: "turn_break" }
  | { type: "done" }
  | { type: "error"; message: string };

const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  search_products: { running: "Searching products", done: "Found products" },
  list_merchants: { running: "Browsing Affirm merchants", done: "Loaded merchants" },
  check_affirm_capacity: { running: "Checking your Affirm account", done: "Checked your Affirm account" },
  calculate_affirm_terms: { running: "Calculating payment plans", done: "Calculated payment plans" },
  execute_purchase: { running: "Placing your order", done: "Order placed" },
  servicing_payoff_quote: { running: "Getting payoff quote", done: "Payoff quote ready" },
  servicing_reschedule_preview: { running: "Checking reschedule rules", done: "Reschedule options ready" },
  servicing_refund_case: { running: "Opening refund case", done: "Refund case opened" },
  servicing_triage_options: { running: "Checking upcoming payments", done: "Triaged your plans" },
  servicing_optimization_options: { running: "Ranking allocation options", done: "Best-use options ready" },
};

/**
 * Demo openers — order matters. The five prompts are arranged so a judge
 * scanning the screen for 30 seconds can see the entire thesis land:
 *
 *   1. Cross-plan triage (cash CONSTRAINT). "I'm going to be short this
 *      month" requires reading every plan's state, checking per-plan
 *      cycle usage, sorting by leverage, and recommending a specific
 *      move. Structurally impossible in the Manage tab.
 *
 *   2. Cross-plan optimization (extra CASH). "I have an extra $500"
 *      requires ranking plans by interest savings, balance-to-clear, and
 *      cash-flow impact — three different right answers depending on
 *      goal. Also impossible in Manage. Symmetric with #1: cross-plan
 *      reasoning at both ends of the cash-flow spectrum.
 *
 *   3 & 4. Same-intent symmetric pose. Identical phrasing on two plans,
 *      opposite outcomes — Peloton (cycle 0) approves, Nike (cycle 1
 *      already used) denies. The "approved vs denied based on real plan
 *      state" proof point.
 *
 *   5. A different action primitive (payoff) so the demo doesn't look
 *      like one tool rephrased four ways.
 *
 * Refund flow still works if a judge types "refund my Nike order" — it's
 * just dropped from the suggested openers to keep the script tight on the
 * thesis.
 */
// Demo suggestions are picked to walk a judge through the agent's three
// differentiating moves in order:
//   1. Cross-plan triage (cash CONSTRAINT) — same intent as Manage but
//      with a recommendation Manage cannot produce.
//   2. Cross-plan optimization (cash SURPLUS) — at $500 the engine
//      surfaces three strategies (save_interest, clear_plan,
//      free_cash_flow) but NOT allocate_across, which requires
//      $1,254+ ($842 Peloton + $412 Nike). Trade-off: more relatable
//      amount vs maximal capability showcase. If a future demo wants
//      to lead on allocate_across specifically, bump this to $1,500.
//   3-5. Single-plan reschedule and payoff intents to demo the policy
//      contrast and biometric authorization on the existing card path.
const SUGGESTIONS = [
  "I'm going to be a little short this month — what are my options?",
  "I have an extra $500 this month, where should I put it?",
  "Move my Peloton payment a week out",
  "Move my Nike payment a week out",
  "Pay off my Peloton loan in full",
];

// Affirm design tokens
const ACCENT = "#6959F8";    // indigo-purple: APR text, CTA links, active elements
const LOGO_BLUE = "#6060EC"; // Affirm arc blue-violet (matches brand logo)
const NAV_ACTIVE = "#0A2540"; // very dark navy for active nav icon
const BG = "#EEEFF3";        // app background
const USER_BUBBLE = "#EAE7F9"; // lavender user bubble

function assistantText(m: Message): string {
  if (m.role !== "assistant") return "";
  return m.blocks
    .filter((b): b is Extract<AssistantBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.content)
    .join("");
}

/**
 * Format a YYYY-MM-DD ISO string as "May 6" (no year). Used everywhere
 * the user sees a date — receipts, prose projections, etc. We never want
 * raw ISO bleeding into UI copy; that's "looks like raw API output" to a
 * judge. Falls back to the input if it isn't a parseable ISO date.
 */
function formatIsoDateShort(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Map an internal policy_code (RESCHEDULE_OK, PAYOFF_OK, ...) to a
 * user-facing receipt-chip label. We deliberately KEEP the codes in the
 * tool output for engineering / audit observability, but strip them
 * from anything the user sees. "RESCHEDULE_OK" on a receipt looks like
 * leaked machine state; "Rescheduled" reads like a confirmation.
 */
function policyCodeToLabel(code: string | undefined): string {
  if (!code) return "Done";
  const c = code.toUpperCase();
  if (c.startsWith("RESCHEDULE")) return "Rescheduled";
  if (c.startsWith("PAYOFF")) return "Paid off";
  if (c.startsWith("PAY_INSTALLMENT")) return "Payment submitted";
  return "Done";
}

/**
 * Project an executed (post-biometric) block into a short assistant-style
 * sentence so the LLM has context for follow-up turns ("did that go through?",
 * "what's left?"). The LLM never produces these strings — we synthesize them
 * after a successful /api/servicing/execute call.
 *
 * Dates are passed through {@link formatIsoDateShort} so the LLM sees
 * "May 6" instead of "2026-05-06" in conversation history. If we hand it
 * raw ISO strings, it tends to parrot them back in prose on follow-up
 * turns, which reads as raw API output to a user.
 */
function executedBlockToText(result: ServicingActionResult): string {
  if ("error" in result) return "";
  const moneyFmt = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const emailNote =
    result.email?.status === "sent" ? " Confirmation sent to inbox." : "";
  if (result.kind === "payoff") {
    return `Done — ${result.merchant} payoff submitted for ${moneyFmt(result.amount_usd)} from ${result.funding_source_label}. Reference ${result.reference_id}.${emailNote}`;
  }
  if (result.kind === "reschedule") {
    return `Done — ${result.merchant} due date moved from ${formatIsoDateShort(result.previous_due_iso)} to ${formatIsoDateShort(result.new_due_iso)}. Reference ${result.reference_id}.${emailNote}`;
  }
  return `Done — extra ${moneyFmt(result.amount_usd)} payment toward ${result.merchant} submitted from ${result.funding_source_label}. Reference ${result.reference_id}.${emailNote}`;
}

function serializeForApi(messages: Message[]) {
  return messages
    .map((m) => {
      if (m.role === "user") return { role: "user", content: m.content };
      const textPieces: string[] = [];
      for (const b of m.blocks) {
        if (b.kind === "text") textPieces.push(b.content);
        else if (b.kind === "executed") textPieces.push(executedBlockToText(b.result));
      }
      const text = textPieces.join("\n").trim();
      if (!text) return null;
      return { role: "assistant", content: text };
    })
    .filter((m): m is { role: "user" | "assistant"; content: string } => m !== null);
}

/**
 * Render a chat-bubble string with the small subset of inline markdown that
 * Claude tends to emit ("**bold**" and "`code`"), so the user doesn't see raw
 * asterisks. Block-level markdown (headings, lists, tables) is intentionally
 * NOT supported — the agent is told never to use it, and stripping list/table
 * syntax visually would be more misleading than instructive. We just want
 * emphasis to render naturally when the agent slips one in.
 */
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let buffer = "";
  let key = 0;
  const flush = () => {
    if (buffer) {
      parts.push(buffer);
      buffer = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        parts.push(
          <strong key={`b${key++}`} className="font-semibold text-[#0A2540]">
            {text.slice(i + 2, end)}
          </strong>
        );
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        parts.push(
          <code
            key={`c${key++}`}
            className="font-mono text-[13px] px-1.5 py-0.5 rounded bg-gray-100 text-[#0A2540]"
          >
            {text.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  flush();
  return parts;
}

/**
 * Project a successful execute result into a LoanOverride suitable for
 * persisting on the JWT. Returns null for error results — those should not
 * affect Manage state.
 */
function overrideFromResult(result: ServicingActionResult): LoanOverride | null {
  if ("error" in result) return null;
  const at = Date.now();
  if (result.kind === "payoff") {
    return {
      kind: "paid_off",
      loanId: result.loan_id,
      refId: result.reference_id,
      amount: result.amount_usd,
      fundingSourceLabel: result.funding_source_label,
      at,
    };
  }
  if (result.kind === "reschedule") {
    return {
      kind: "rescheduled",
      loanId: result.loan_id,
      previousDueIso: result.previous_due_iso,
      newDueIso: result.new_due_iso,
      refId: result.reference_id,
      at,
    };
  }
  return {
    kind: "extra_payment",
    loanId: result.loan_id,
    amount: result.amount_usd,
    fundingSourceLabel: result.funding_source_label,
    refId: result.reference_id,
    at,
  };
}

function friendlyAuthError(err: AuthorizationError): string {
  if (err.code === "verification_failed") return "Biometric didn't match. Try again.";
  if (err.code === "no_credential")
    return "Couldn't find a passkey. Tap again to set one up.";
  if (err.code === "auth_failed") return "Authorization expired. Tap again.";
  if (err.message.includes("NotAllowedError"))
    return "Biometric prompt was dismissed.";
  if (err.message.includes("InvalidStateError"))
    return "A passkey is already set up. Try again.";
  return err.message || "Couldn't authorize. Try again.";
}

export default function Home() {
  const { data: session, status: authStatus, update: updateSession } = useSession();
  const [view, setView] = useState<"home" | "chat" | "manage">("home");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [pendingExplainer, setPendingExplainer] = useState<{ planLabel: string; price?: number } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ planLabel: string; price?: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showArchitectureSheet, setShowArchitectureSheet] = useState(false);
  // Sticky "ever authenticated this session" flag. Once we've seen an
  // authenticated session, transient `authStatus === "loading"` flickers
  // (caused by NextAuth's update() call after a servicing action persists
  // a loan override) should NOT dump the user back to the loading screen
  // — that unmounts the whole chat surface and resets scroll position to
  // the top, stranding the user above the new success card.
  const [hasAuthedOnce, setHasAuthedOnce] = useState(false);
  useEffect(() => {
    if (authStatus === "authenticated") setHasAuthedOnce(true);
  }, [authStatus]);
  // Tracks the loan_id that was just touched by an authorized servicing action.
  // Manage screen reads this to surface a "Just updated" pill on the right card.
  const [recentlyUpdatedLoanId, setRecentlyUpdatedLoanId] = useState<string | null>(null);
  // Per-card biometric lifecycle. Keyed by the tool_use block id of the
  // quote/preview card the user is acting on.
  const [executionState, setExecutionState] = useState<
    Record<string, BiometricExecutionState>
  >({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sentinel rendered at the end of the chat list. We scroll THIS into
  // view (rather than computing scrollHeight ourselves) so the browser
  // handles all the layout/timing edge cases — late-loading images,
  // CSS animations, conditional renders that grow the message after
  // mount. Far more reliable than chained setTimeout calls.
  const endRef = useRef<HTMLDivElement>(null);

  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const authError = searchParams?.get("error") ?? undefined;

  // Track the loan_id of every plan the user has paid off in this session.
  // Used by the post-action "next step" chips to compute remaining-plan
  // state ("Marriott is now your highest rate") without round-tripping to
  // the server. Reschedule and pay-installment don't close a plan, so they
  // don't enter this set.
  const paidOffLoanIds = useMemo(() => {
    const set = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const block of msg.blocks) {
        if (
          block.kind === "executed" &&
          !("error" in block.result) &&
          block.result.kind === "payoff"
        ) {
          set.add(block.result.loan_id);
        }
      }
    }
    return set;
  }, [messages]);

  // Location of the most-recent successful executed block (msg index +
  // block index). The "next step" chips render ONLY on this block — older
  // executed blocks don't show chips, so the user always knows which
  // action the suggestions are responding to. Tuple is null on first load
  // and any time the latest block isn't a successful action (e.g. pure
  // text response).
  const latestSuccessfulActionLocation = useMemo<{
    mi: number;
    bi: number;
  } | null>(() => {
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const msg = messages[mi];
      if (msg.role !== "assistant") continue;
      for (let bi = msg.blocks.length - 1; bi >= 0; bi--) {
        const b = msg.blocks[bi];
        if (b.kind === "executed" && !("error" in b.result)) {
          return { mi, bi };
        }
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    // Sentinel-based scroll-to-bottom. We scroll the end-of-list
    // sentinel into view, then keep scrolling it into view for ~1500ms
    // every time the content size changes. ResizeObserver fires for
    // any reflow inside the chat — late-loading merchant logos, the
    // success card replacing the action button, next-step chips
    // appearing, NextAuth session-driven re-renders. This is strictly
    // more reliable than chained setTimeout calls because it reacts to
    // ACTUAL layout settling rather than guessing at it.
    const sentinel = endRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container) return;

    let cancelled = false;
    const scrollToEnd = (behavior: ScrollBehavior) => {
      if (cancelled) return;
      sentinel.scrollIntoView({ block: "end", behavior });
    };

    scrollToEnd("smooth");
    const raf = requestAnimationFrame(() => scrollToEnd("auto"));

    const ro = new ResizeObserver(() => scrollToEnd("auto"));
    if (container.firstElementChild) ro.observe(container.firstElementChild);
    ro.observe(sentinel);

    const stopTimer = setTimeout(() => {
      ro.disconnect();
    }, 1500);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(stopTimer);
      ro.disconnect();
    };
  }, [messages]);

  useEffect(() => {
    if (view !== "chat") return;
    const el = scrollRef.current;
    if (!el) return;
    const scrollToEnd = () => { el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior }); };
    scrollToEnd();
    const raf = requestAnimationFrame(scrollToEnd);
    const ro = new ResizeObserver(scrollToEnd);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    const stopTimer = setTimeout(() => ro.disconnect(), 2000);
    return () => { cancelAnimationFrame(raf); clearTimeout(stopTimer); ro.disconnect(); };
  }, [view]);

  useEffect(() => {
    // We persist `view` so a refresh doesn't bounce the user back to
    // home, but we deliberately do NOT persist `messages`. A judge who
    // opens the demo a second time should land on a clean chat — not a
    // graveyard of old quote/preview cards from the previous session,
    // some of which may be in weird mid-action states. Strip any
    // legacy persisted messages from prior builds at the same time.
    try {
      const savedView = localStorage.getItem("affirm_view");
      if (savedView === "home" || savedView === "chat" || savedView === "manage")
        setView(savedView);
      localStorage.removeItem("affirm_messages");
    } catch { /* ignore */ } finally { setHydrated(true); }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("affirm_view", view);
    } catch { /* storage full */ }
  }, [hydrated, view]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && pendingConfirm) {
        setPendingConfirm(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingConfirm]);

  async function send(text: string) {
    if (!text.trim() || streaming) return;
    const userMessage: Message = { role: "user", content: text };
    const historyForApi = serializeForApi([...messages, userMessage]);
    const baseMessages: Message[] = [...messages, userMessage, { role: "assistant", blocks: [] }];
    setMessages(baseMessages);
    setInput("");
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForApi }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const assistantIndex = baseMessages.length - 1;
      const currentBlocks: AssistantBlock[] = [];
      let forceNewTextBlock = false;
      const applyEvent = (event: StreamEvent) => {
        if (event.type === "text") {
          const last = currentBlocks[currentBlocks.length - 1];
          if (!forceNewTextBlock && last && last.kind === "text") { last.content += event.delta; }
          else { currentBlocks.push({ kind: "text", content: event.delta }); forceNewTextBlock = false; }
        } else if (event.type === "tool_use") {
          currentBlocks.push({ kind: "tool", id: event.id, name: event.name, status: "running" });
        } else if (event.type === "tool_result") {
          const block = currentBlocks.find((b): b is Extract<AssistantBlock, { kind: "tool" }> => b.kind === "tool" && b.id === event.id);
          if (block) { block.status = "complete"; block.result = event.result; }
        } else if (event.type === "turn_break") { forceNewTextBlock = true; }
        else if (event.type === "error") { currentBlocks.push({ kind: "error", message: event.message }); }
      };
      const flush = () => {
        setMessages((prev) => {
          const next = prev.slice();
          next[assistantIndex] = { role: "assistant", blocks: currentBlocks.map((b) => ({ ...b })) };
          return next;
        });
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;
          try { const event = JSON.parse(line) as StreamEvent; applyEvent(event); } catch { /* ignore */ }
        }
        flush();
      }
      flush();
    } catch (err) {
      console.error(err);
      const friendly = err instanceof TypeError && err.message.includes("fetch")
        ? "Couldn't reach the Affirm Agent. Check your connection and try again."
        : "Something went wrong. Please try again.";
      setMessages((prev) => {
        const next = prev.slice();
        next[next.length - 1] = { role: "assistant", blocks: [{ kind: "error", message: friendly }] };
        return next;
      });
    } finally { setStreaming(false); }
  }

  function retryLast() {
    if (streaming) return;
    const lastUser = [...messages].reverse().find((m): m is Extract<Message, { role: "user" }> => m.role === "user");
    if (!lastUser) return;
    setMessages((prev) => { const idx = prev.findIndex((m) => m === lastUser); return prev.slice(0, idx); });
    setTimeout(() => send(lastUser.content), 0);
  }

  /**
   * Run the biometric -> deterministic-execute flow for one quote/preview card.
   *
   * - blockId: tool_use id of the card the user tapped (used to key per-card UI state)
   * - action: the servicing action params; the auth token is bound to this exact shape
   *
   * On success we append a synthetic "executed" assistant message containing the
   * success card. On failure we surface the error message inline on the card.
   */
  async function runServicingAction(
    blockId: string,
    action: ServicingActionParams
  ) {
    setExecutionState((s) => ({ ...s, [blockId]: { phase: "authenticating" } }));
    const hasPasskey = Boolean(
      (session as unknown as { passkey?: { credentialId: string } } | null)
        ?.passkey?.credentialId
    );
    let result: ServicingActionResult;
    try {
      result = await authorizeAndExecute(action, hasPasskey, updateSession);
    } catch (err) {
      const message =
        err instanceof AuthorizationError
          ? friendlyAuthError(err)
          : err instanceof Error
          ? err.message
          : "Couldn't authorize. Try again.";
      setExecutionState((s) => ({
        ...s,
        [blockId]: { phase: "error", message },
      }));
      return;
    }

    setExecutionState((s) => ({ ...s, [blockId]: { phase: "submitting" } }));

    if ("error" in result) {
      setExecutionState((s) => ({
        ...s,
        [blockId]: {
          phase: "error",
          message: result.message ?? String(result.error),
        },
      }));
      return;
    }

    // Inject the success card as a NEW assistant message so the chat reads
    // "Assistant surfaced quote -> User authorized -> Assistant confirmed".
    setMessages((prev) => [
      ...prev,
      { role: "assistant", blocks: [{ kind: "executed", result }] },
    ]);
    setExecutionState((s) => ({ ...s, [blockId]: { phase: "done" } }));

    // Persist the mutation onto the user's JWT so the Manage screen reflects it
    // ("paid in full", "due date moved", etc). We don't await this — the chat
    // success UX shouldn't block on a session token round-trip — but we fire
    // it before the user has any chance to navigate to Manage.
    const override = overrideFromResult(result);
    if (override) {
      // Mark this loan as freshly touched so Manage can highlight it. Cleared
      // after a few seconds so subsequent visits are calm.
      setRecentlyUpdatedLoanId(override.loanId);
      setTimeout(() => {
        setRecentlyUpdatedLoanId((current) =>
          current === override.loanId ? null : current
        );
      }, 8000);
      updateSession({ loanOverride: override }).catch((err) => {
        console.error("Failed to persist loan override:", err);
      });
    }
  }

  const last = messages[messages.length - 1];
  const showThinking = streaming && last?.role === "assistant" && last.blocks.length === 0;

  // Show the loading wordmark only on initial bootstrap. Once we've ever
  // been authenticated this session, any subsequent "loading" status is a
  // transient session-refresh (e.g. after updateSession persists a loan
  // override) and we should NOT unmount the chat — it loses scroll
  // position. See hasAuthedOnce above.
  const showBootstrapLoader =
    !hydrated || (authStatus === "loading" && !hasAuthedOnce);
  if (showBootstrapLoader) {
    return (
      <PhoneFrame>
        <div className="flex-1 flex items-center justify-center" style={{ background: BG }}>
          <AffirmWordmark />
        </div>
      </PhoneFrame>
    );
  }

  if (authStatus === "unauthenticated" || !session?.user?.email) {
    return <PhoneFrame><LoginScreen error={authError} /></PhoneFrame>;
  }

  const firstName =
    session.user.name?.split(" ")[0] ||
    session.user.email.split("@")[0].split(".")[0].replace(/^./, (c) => c.toUpperCase());

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
  };

  const openChatWith = (prefill?: string) => {
    setView("chat");
    if (prefill) setTimeout(() => send(prefill), 0);
  };

  if (view === "home") {
    return (
      <PhoneFrame>
        <HomeScreen
          firstName={firstName}
          avatarUrl={session.user.image ?? null}
          onOpenChat={openChatWith}
          onOpenManage={() => setView("manage")}
          onToast={showToast}
          toast={toast}
          onSignOut={() => {
            localStorage.removeItem("affirm_view");
            signOut({ callbackUrl: "/" });
          }}
        />
      </PhoneFrame>
    );
  }

  if (view === "manage") {
    return (
      <PhoneFrame>
        <ManageScreen
          onBack={() => setView("home")}
          onOpenChatWith={(prefill) => openChatWith(prefill)}
          onResetDemo={async () => {
            await updateSession({ loanOverridesReset: true });
            setRecentlyUpdatedLoanId(null);
          }}
          onSignOut={() => {
            localStorage.removeItem("affirm_view");
            signOut({ callbackUrl: "/" });
          }}
          recentlyUpdatedLoanId={recentlyUpdatedLoanId}
        />
      </PhoneFrame>
    );
  }

  return (
    <PhoneFrame>
      <div className="flex flex-col h-full" style={{ background: BG }}>
        {/* Chat header — matches real Affirm "Chat" screen */}
        <header className="flex items-center px-4 py-3 relative" style={{ background: BG }}>
          <button
            onClick={() => setView("home")}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-black/5 transition"
            aria-label="Back"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={NAV_ACTIVE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="absolute left-1/2 -translate-x-1/2 text-[17px] font-bold text-[#0A2540]">Chat</span>
          <button
            onClick={() => setShowArchitectureSheet(true)}
            className="ml-auto w-9 h-9 flex items-center justify-center rounded-full hover:bg-black/5 transition"
            aria-label="How this works"
            title="How this works"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={NAV_ACTIVE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </button>
        </header>

        {/* "Chat with Affirm Assistant" subheader + value-prop subtitle.
            The subtitle frames the agent's actual capability set so the
            user (and any judge watching) doesn't ask "why not just use
            the Manage tab?" — the answer is right there on screen. */}
        <div className="px-5 py-2.5 border-b border-gray-200/80" style={{ background: BG }}>
          <div className="flex items-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-3">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
            <span className="flex-1 text-[15px] font-semibold text-[#0A2540]">Chat with Affirm Assistant</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#8E8E93">
              <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
            </svg>
          </div>
          <div className="text-[12px] text-gray-500 mt-1 leading-snug pl-[30px]">
            Ask me anything about your plans — I can reschedule, help you pay off early, or figure out your best move.
          </div>
        </div>

        <main ref={scrollRef} className="flex-1 overflow-y-auto">
          {/*
           * Single inner wrapper holds the whole list. We attach a
           * ResizeObserver to this element so ANY height change inside
           * the chat (new message, image load, success card replacing
           * an action card, chips appearing) triggers another scroll-
           * to-bottom pass. Padding lives here, not on <main>, so the
           * observer's target is the natural content box.
           */}
          <div className="px-4 py-4 space-y-4">
          {messages.length === 0 && <EmptyState onPick={send} />}

          {messages.map((msg, i) => {
            if (msg.role === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div
                    className="max-w-[85%] rounded-[20px] rounded-br-[6px] px-4 py-2.5 whitespace-pre-wrap text-[15px] text-[#0A2540]"
                    style={{ backgroundColor: USER_BUBBLE }}
                  >
                    {msg.content}
                  </div>
                </div>
              );
            }
            if (msg.blocks.length === 0) return null;
            return (
              <div key={i} className="flex justify-start gap-0">
                <div className="max-w-[92%] space-y-2 flex-1">
                  {msg.blocks.map((block, bi) => (
                    <AssistantBlockView
                      key={bi}
                      block={block}
                      onPickPlan={(label, price) => setPendingExplainer({ planLabel: label, price })}
                      onPickProduct={(text) => send(text)}
                      onRetry={retryLast}
                      executionState={executionState}
                      onAuthorize={runServicingAction}
                      onViewInManage={() => setView("manage")}
                      isLatestSuccessfulAction={
                        latestSuccessfulActionLocation?.mi === i &&
                        latestSuccessfulActionLocation?.bi === bi
                      }
                      paidOffLoanIds={paidOffLoanIds}
                    />
                  ))}
                  <div className="text-[11px] text-[#8E8E93] pl-1">Affirm Assistant</div>
                </div>
              </div>
            );
          })}

          {showThinking && (
            <div className="flex justify-start">
              <div className="bg-white rounded-[20px] rounded-tl-[6px] px-4 py-3 shadow-sm">
                <TypingDots />
              </div>
            </div>
          )}

          {/*
           * End-of-list sentinel. The scroll-to-bottom effect targets
           * THIS element via scrollIntoView. Keeping it as a real DOM
           * node (rather than computing scrollHeight ourselves) lets
           * the browser handle all the layout edge cases for free.
           */}
          <div ref={endRef} aria-hidden="true" />
          </div>
        </main>

        <footer className="border-t border-gray-200/80 px-4 py-3 bg-white">
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send(input)}
              placeholder="Reschedule, pay off, or ask what to do…"
              disabled={streaming}
              className="flex-1 bg-[#F2F3F5] rounded-full px-4 py-2.5 text-[15px] text-[#0A2540] placeholder:text-[#8E8E93] focus:outline-none focus:ring-2 disabled:opacity-50"
              style={{ ["--tw-ring-color" as string]: ACCENT + "40" }}
            />
            <button
              onClick={() => send(input)}
              disabled={streaming || !input.trim()}
              className="flex items-center justify-center w-10 h-10 rounded-full text-white transition disabled:opacity-30"
              style={{ backgroundColor: ACCENT }}
              aria-label="Send"
            >
              <SendIcon />
            </button>
          </div>
        </footer>

        {pendingExplainer && (
          <PurchaseExplainer
            planLabel={pendingExplainer.planLabel}
            price={pendingExplainer.price}
            onCancel={() => setPendingExplainer(null)}
            onContinue={() => {
              const { planLabel, price } = pendingExplainer;
              setPendingExplainer(null);
              setPendingConfirm({ planLabel, price });
            }}
          />
        )}

        {pendingConfirm && (
          <BiometricGate
            planLabel={pendingConfirm.planLabel}
            price={pendingConfirm.price}
            onCancel={() => setPendingConfirm(null)}
            onSuccess={() => {
              const label = pendingConfirm.planLabel;
              setPendingConfirm(null);
              send(`Yes, confirm and purchase with ${label}.`);
            }}
          />
        )}

        {showArchitectureSheet && (
          <ArchitectureSheet onClose={() => setShowArchitectureSheet(false)} />
        )}
      </div>
    </PhoneFrame>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  /*
   * Use h-screen on the OUTER wrapper (not min-h-screen) so the page never
   * scrolls. Subtract the desktop padding from the inner phone height so the
   * phone always fits inside the viewport at 100% browser zoom — including
   * the bottom nav labels of the screenshot home.
   */
  return (
    <div className="h-screen bg-[#D8D9DF] flex items-center justify-center md:py-6 overflow-hidden">
      {/*
       * Phone-frame width is matched to the home screenshot's native aspect
       * ratio (1179:2556 ≈ 0.461). At ~860px tall, that's ~396px wide — also
       * close to real iPhone 14/15 logical width (390px), so the prototype
       * looks like an actual phone with no side bezels next to the home image.
       */}
      <div className="relative w-full max-w-[396px] h-full md:h-[min(860px,calc(100vh-3rem))] md:rounded-[44px] md:shadow-[0_24px_80px_rgba(10,37,64,0.18)] flex flex-col overflow-hidden md:border md:border-gray-300/40">
        {children}
      </div>
    </div>
  );
}

function AffirmWordmark({ dark = true }: { dark?: boolean }) {
  const textColor = dark ? "#000000" : "#FFFFFF";
  return (
    <svg width="88" height="52" viewBox="0 0 170 100" fill="none">
      {/*
        Circle center ≈ (102, 89), r≈53.
        Left endpoint (55,65): at the "ff/i" boundary, cap-height level.
        Arc climbs to apex ≈ (102,36), then sweeps right and DOWN.
        Right endpoint (155,96): just below text baseline, past the "m".
        SVG: small-arc=0, sweep=1 (clockwise through the top).
      */}
      <path
        d="M 55 65 A 53 53 0 0 1 155 96"
        stroke={LOGO_BLUE}
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
      />
      <text
        x="2"
        y="90"
        fill={textColor}
        fontSize="34"
        fontWeight="800"
        fontFamily="var(--font-geist-sans), -apple-system, sans-serif"
        letterSpacing="-0.5"
      >
        affirm
      </text>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l14-7-7 14-2-5-5-2z" />
    </svg>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" />
    </div>
  );
}

function MerchantAvatar({ name }: { name: string }) {
  const palette = [ACCENT, "#0A2540", "#FF6F3C", "#00B894", "#0984E3", "#E17055"];
  const hash = Array.from(name).reduce((h, c) => h + c.charCodeAt(0), 0);
  const bg = palette[hash % palette.length];
  const initials = name.split(" ").map((w) => w.charAt(0)).join("").slice(0, 2).toUpperCase();
  return (
    <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
      <span className="text-white text-[13px] font-semibold tracking-wide">{initials}</span>
    </div>
  );
}

/**
 * HomeScreen renders a screenshot of the live Affirm app as the background and
 * overlays transparent hot zones for the elements we want to be tappable in the
 * demo. This is intentional — the hackathon scope is the Assistant, so we don't
 * recreate the home pixel-by-pixel. A pulsing dot draws judges' eyes to the
 * chat icon (top right of the header), which opens the Affirm Assistant.
 */
function HomeScreen({
  onOpenChat, onOpenManage, onToast, toast, onSignOut,
}: {
  onOpenChat: (prefill?: string) => void;
  onOpenManage: () => void;
  onToast: (msg: string) => void;
  toast: string | null;
  firstName: string;
  avatarUrl: string | null;
  onSignOut: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [innerSize, setInnerSize] = useState<{ w: number; h: number } | null>(null);

  /*
   * The screenshot is 1179 × 2556. The phone-frame container is a different
   * aspect ratio, so naive object-cover clips top/bottom and the hot-zone math
   * breaks. We compute, in JS, the largest box that matches the screenshot's
   * exact aspect ratio, and put the image + every hot zone inside that box. As
   * a result, every percentage below is a percentage of the screenshot itself,
   * not the container — so the tap targets land where the icons render.
   */
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const IMG_RATIO = 1179 / 2556;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const containerRatio = width / height;
      let w: number;
      let h: number;
      if (containerRatio > IMG_RATIO) {
        h = height;
        w = height * IMG_RATIO;
      } else {
        w = width;
        h = width / IMG_RATIO;
      }
      setInnerSize({ w: Math.round(w), h: Math.round(h) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden flex items-center justify-center"
      style={{ background: "#0A0E2C" }}
    >
      {imgFailed && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-full bg-red-500/90 text-white text-[11px] font-semibold">
          /affirm-home.png failed to load — check deploy
        </div>
      )}

      {toast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-[#0A2540]/90 backdrop-blur text-[13px] font-medium text-white whitespace-nowrap">
          {toast}
        </div>
      )}

      <div
        className="relative"
        style={{
          width: innerSize?.w ?? 0,
          height: innerSize?.h ?? 0,
          background:
            "linear-gradient(180deg, #0A0E2C 0%, #1B1A52 18%, #2A2A8A 28%, #EEEFF3 30%, #EEEFF3 100%)",
          visibility: innerSize ? "visible" : "hidden",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/affirm-home.png"
          alt="Affirm home"
          draggable={false}
          onError={() => setImgFailed(true)}
          className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
        />

        {/*
         * Hot zones over the screenshot. Coordinates are % of the screenshot.
         *
         * The chat-icon and profile zones are intentionally generous — the
         * visible icons are small but a forgiving target avoids the "I tapped
         * the icon and nothing happened" demo failure mode.
         */}
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Account / Sign out"
          title="Sign out"
          className="absolute z-20 cursor-pointer"
          style={{ top: "3%", right: "12%", width: "13%", height: "12%" }}
        />
        <button
          type="button"
          onClick={() => onOpenChat()}
          aria-label="Affirm Assistant"
          title="Open Affirm Assistant"
          className="absolute z-20 cursor-pointer"
          style={{ top: "3%", right: "0%", width: "12%", height: "12%" }}
        />
        <button
          type="button"
          onClick={() => onToast("Search — coming soon")}
          aria-label="Search"
          className="absolute z-20 cursor-pointer"
          style={{ top: "31%", left: "4%", width: "92%", height: "6.2%" }}
        />

        {/*
         * Bottom nav: 5 equal tabs. Only the chat icon enters the Assistant.
         * Hot-zone height is intentionally generous (12%) — the actual icons
         * sit at ~91% from the top of the screenshot and the labels sit at
         * ~94%. An 8% strip starting from the bottom catches only the labels
         * and home indicator, missing the icon itself. 12% covers the full
         * nav (icon + label + safe area) so taps on either one always land.
         */}
        <button
          type="button"
          onClick={() => onToast("You're on Home")}
          aria-label="Home"
          className="absolute z-20 cursor-pointer"
          style={{ bottom: "0%", left: "0%", width: "20%", height: "12%" }}
        />
        <button
          type="button"
          onClick={() => onToast("Deals — coming soon")}
          aria-label="Deals"
          className="absolute z-20 cursor-pointer"
          style={{ bottom: "0%", left: "20%", width: "20%", height: "12%" }}
        />
        <button
          type="button"
          onClick={() => onToast("Affirm Card — coming soon")}
          aria-label="Card"
          className="absolute z-20 cursor-pointer"
          style={{ bottom: "0%", left: "40%", width: "20%", height: "12%" }}
        />
        <button
          type="button"
          onClick={onOpenManage}
          aria-label="Manage"
          title="Manage your loans"
          className="absolute z-20 cursor-pointer"
          style={{ bottom: "0%", left: "60%", width: "20%", height: "12%" }}
        />
        <button
          type="button"
          onClick={() => onToast("Money — coming soon")}
          aria-label="Money"
          className="absolute z-20 cursor-pointer"
          style={{ bottom: "0%", left: "80%", width: "20%", height: "12%" }}
        />
      </div>
    </div>
  );
}


function LoginScreen({ error }: { error?: string }) {
  const [submitting, setSubmitting] = useState(false);
  async function handleGoogle() { setSubmitting(true); await signIn("google", { callbackUrl: "/" }); }
  return (
    <div className="flex flex-col h-full" style={{ background: BG }}>
      <div className="flex-1 flex flex-col px-6 pt-16 pb-8">
        <div className="flex justify-center mb-16">
          <AffirmWordmark dark />
        </div>
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-[28px] font-bold text-[#0A2540] leading-tight">Welcome, Affirmer</h1>
            <p className="text-[15px] text-gray-500 mt-2 leading-relaxed">
              Sign in with your Affirm Google account to try the Affirm Agent hackathon prototype.
            </p>
          </div>
          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-[13px] text-red-700">
              {error === "AccessDenied" ? "Access denied — you must sign in with an @affirm.com account." : "Sign-in failed. Please try again."}
            </div>
          )}
          <button
            type="button"
            onClick={handleGoogle}
            disabled={submitting}
            className="w-full py-3.5 rounded-full bg-[#0A2540] text-white font-semibold flex items-center justify-center gap-2.5 hover:bg-[#0d2f52] transition disabled:opacity-60"
          >
            <GoogleIcon />
            {submitting ? "Opening Google…" : "Continue with Google"}
          </button>
          <div className="flex items-center gap-2 text-[12px] text-gray-400 justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            Restricted to @affirm.com accounts
          </div>
          <p className="text-[11px] text-gray-400 text-center mt-2 leading-relaxed px-4">
            Hackathon prototype — not production Affirm infrastructure. By continuing, you agree to Affirm&apos;s Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * "How this works" sheet, surfaced from the chat header help icon.
 *
 * This is the single highest-leverage surface for hackathon judges: even if
 * they don't watch the demo video or read the brief, opening this sheet gives
 * them the entire architectural pitch in 30 seconds — LLM as orchestrator,
 * deterministic policy engine as the source of truth, biometric as the
 * authorization. The three-row visual maps directly to the three boxes in
 * the architecture diagram.
 */
function ArchitectureSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-label="How this works"
    >
      <div
        className="w-full bg-white rounded-t-3xl shadow-2xl flex flex-col max-h-[88%]"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "slideUp 240ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
      >
        <style jsx>{`
          @keyframes slideUp {
            from { transform: translateY(24px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
        `}</style>
        <div className="flex justify-center pt-2.5 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>
        <div className="px-6 pt-3 pb-2 flex items-start justify-between">
          <div className="flex-1 pr-3">
            <div className="text-[11px] uppercase tracking-wide font-bold text-[#6959F8]">
              Affirm Agent
            </div>
            <h2 className="text-[20px] font-bold text-[#0A2540] mt-0.5 leading-tight">
              How this works
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 transition flex items-center justify-center"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0A2540" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-6 pb-2 text-[13px] text-gray-600 leading-relaxed">
          The agent feels conversational, but money never moves on the LLM&apos;s say-so. Three layers, each with one job:
        </div>

        <div className="px-6 py-4 space-y-3 overflow-y-auto">
          <ArchitectureRow
            num="1"
            title="LLM understands intent"
            subtitle="Claude parses natural language into a servicing action and surfaces a quote/preview card. It can read your plans — it cannot execute anything."
            tag="Read-only tools"
            tagColor="#6959F8"
          />
          <ArchitectureRow
            num="2"
            title="Policy engine decides"
            subtitle="Deterministic code checks plan terms (window, cycle limits, balance) and returns the eligibility outcome with a policy code. Same intent, different plan state, different outcome."
            tag="Source of truth"
            tagColor="#0f7a4e"
          />
          <ArchitectureRow
            num="3"
            title="Face ID authorizes"
            subtitle="Tapping Confirm fires WebAuthn. The signed assertion mints a 90-second token bound to that exact action. The deterministic executor runs the action — the LLM is never in this path."
            tag="Step-up auth"
            tagColor="#0A2540"
          />
        </div>

        <div className="px-6 pt-2 pb-5">
          <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-[12px] text-gray-700 leading-relaxed">
            <span className="font-semibold text-[#0A2540]">Try it:</span> ask &quot;Move my Peloton payment 2 weeks out&quot; and then &quot;Move my Nike payment 2 weeks out.&quot; Same words, different policy outcome — Nike&apos;s next payment has already been moved once.
          </div>
        </div>
      </div>
    </div>
  );
}

function ArchitectureRow({
  num,
  title,
  subtitle,
  tag,
  tagColor,
}: {
  num: string;
  title: string;
  subtitle: string;
  tag: string;
  tagColor: string;
}) {
  return (
    <div className="flex gap-3">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[13px] font-bold shrink-0"
        style={{ background: tagColor }}
      >
        {num}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px] font-semibold text-[#0A2540]">{title}</span>
          <span
            className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded text-white"
            style={{ background: tagColor }}
          >
            {tag}
          </span>
        </div>
        <div className="text-[12px] text-gray-600 leading-relaxed mt-1">
          {subtitle}
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.7 2.2-2.1 4.1-4 5.5l6.2 5.2C41 35.6 44 30.3 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </svg>
  );
}

/**
 * Plans screen — the demo's "did the action actually do anything?" surface.
 *
 * Visually mirrors the real Affirm app's Plans tab (dark navy hero with
 * total balance, Active/Completed tabs, Upcoming payments + Current plans
 * sections) so judges immediately recognize where servicing actions land.
 *
 * Reads /api/loans, which folds JWT-stored servicing overrides into the base
 * mock data. Mounting causes a fetch, so navigating chat -> back -> plans
 * after a successful authorization always shows the latest state. We also
 * refetch when the session changes (the JWT is updated after a successful
 * /api/servicing/execute, which triggers a session change client-side).
 */
type UpcomingFilter = "week" | "month" | "next";

function daysFromTodayLocal(iso: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return Number.POSITIVE_INFINITY;
  due.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function nextPaymentStatusLabel(iso: string): { label: string; isOverdue: boolean } {
  if (!iso) return { label: "", isOverdue: false };
  const days = daysFromTodayLocal(iso);
  if (days < 0) {
    const n = Math.abs(days);
    return { label: `Overdue ${n} day${n === 1 ? "" : "s"}`, isOverdue: true };
  }
  if (days === 0) return { label: "Due today", isOverdue: false };
  if (days === 1) return { label: "Due tomorrow", isOverdue: false };
  if (days <= 30) return { label: `Due in ${days} days`, isOverdue: false };
  const d = new Date(iso);
  return {
    label: `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    isOverdue: false,
  };
}

function inFilter(loan: LoanView, filter: UpcomingFilter): boolean {
  if (loan.status !== "active" || !loan.nextPaymentDateIso) return false;
  const due = new Date(loan.nextPaymentDateIso);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  if (filter === "week") {
    const days = daysFromTodayLocal(loan.nextPaymentDateIso);
    return days <= 7;
  }
  if (filter === "month") {
    return (
      due.getMonth() === today.getMonth() &&
      due.getFullYear() === today.getFullYear()
    );
  }
  // next month
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return (
    due.getMonth() === next.getMonth() &&
    due.getFullYear() === next.getFullYear()
  );
}

/**
 * Round merchant logo with clearbit fallback to an initial bubble. Matches
 * the small circular brand mark on each row in the real Plans tab.
 */
function MerchantLogo({
  domain,
  name,
  size = 40,
  paidOff = false,
}: {
  domain: string;
  name: string;
  size?: number;
  paidOff?: boolean;
}) {
  const [imgErr, setImgErr] = useState(false);
  const initial = name.charAt(0).toUpperCase();
  const showLogo = Boolean(domain) && !imgErr && !paidOff;
  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold shrink-0 overflow-hidden border ${
        paidOff
          ? "bg-emerald-100 text-emerald-700 border-emerald-200"
          : "bg-white text-[#0A2540] border-gray-200"
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {paidOff ? (
        <svg
          width={Math.round(size * 0.5)}
          height={Math.round(size * 0.5)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://logo.clearbit.com/${domain}`}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => setImgErr(true)}
        />
      ) : (
        initial
      )}
    </div>
  );
}

/**
 * One-line row in the "Upcoming payments" section. Tapping the dark pill
 * routes the user into the chat with a pay-installment intent prefilled,
 * which then runs through the policy engine + Face ID just like any other
 * servicing action.
 */
function UpcomingPaymentRow({
  loan,
  onPay,
  justUpdated,
}: {
  loan: LoanView;
  onPay: (prefill: string) => void;
  justUpdated: boolean;
}) {
  const status = nextPaymentStatusLabel(loan.nextPaymentDateIso);
  const ringClass = justUpdated
    ? "border-[#6959F8] ring-2 ring-[#6959F8]/30"
    : "border-gray-200";
  return (
    <div
      className={`bg-white border rounded-2xl px-3 py-3 flex items-center gap-3 transition ${ringClass}`}
    >
      <MerchantLogo domain={loan.merchantDomain} name={loan.merchant} size={40} />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-bold text-[#0A2540] truncate">
          {loan.merchant}
        </div>
        <div
          className={`text-[12px] mt-0.5 ${
            status.isOverdue ? "text-red-600 font-semibold" : "text-gray-500"
          }`}
        >
          {status.label || "—"}
        </div>
      </div>
      <button
        type="button"
        onClick={() =>
          onPay(
            `I want to pay my next ${loan.merchant} installment of ${formatMoneyM(
              loan.monthlyPaymentUsd
            )} now.`
          )
        }
        className="bg-[#0A2540] text-white text-[13px] font-semibold px-4 py-2 rounded-full whitespace-nowrap hover:bg-[#0A2540]/90 transition"
      >
        Pay {formatMoneyM(loan.monthlyPaymentUsd)}
      </button>
    </div>
  );
}

function ManageScreen({
  onBack,
  onOpenChatWith,
  onResetDemo,
  onSignOut,
  recentlyUpdatedLoanId,
}: {
  onBack: () => void;
  onOpenChatWith: (prefill: string) => void;
  onResetDemo: () => Promise<void>;
  onSignOut: () => void;
  recentlyUpdatedLoanId: string | null;
}) {
  const { data: session } = useSession();
  const [loans, setLoans] = useState<LoanView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  // Refetch when the session token changes (NextAuth fires this after every
  // updateSession() call — including loanOverride pushes from the chat).
  // Using `loanOverrides` length on the session is enough of a fingerprint to
  // detect "user just authorized something"; the server is the source of
  // truth either way.
  const overrideKey =
    (session as unknown as { loanOverrides?: unknown[] })?.loanOverrides
      ?.length ?? 0;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/loans", { credentials: "same-origin" });
        const data = (await res.json()) as { loans?: LoanView[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? `Couldn't load loans (${res.status})`);
          return;
        }
        setLoans(data.loans ?? []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load loans");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [overrideKey]);

  const handleReset = async () => {
    setResetting(true);
    try {
      await onResetDemo();
      // Refetch immediately — overrideKey will also flip but this avoids a
      // visible flash of stale data while the session callback round-trips.
      const res = await fetch("/api/loans", { credentials: "same-origin" });
      const data = (await res.json()) as { loans?: LoanView[] };
      setLoans(data.loans ?? []);
    } finally {
      setResetting(false);
    }
  };

  // Active vs Completed tab — mirrors the real Plans tab. Completed shows
  // anything the user has paid off in the demo so they can prove to
  // themselves that the action moved a loan across the boundary.
  const [tab, setTab] = useState<"active" | "completed">("active");
  const [upcomingFilter, setUpcomingFilter] = useState<UpcomingFilter>("week");

  const activeLoans = (loans ?? []).filter((l) => l.status === "active");
  // Sort Completed newest-first so the most recent payoffs land at the top
  // (matches the real Affirm Plans tab ordering).
  const completedLoans = (loans ?? [])
    .filter((l) => l.status === "paid_off")
    .sort((a, b) => b.paidOffDateIso.localeCompare(a.paidOffDateIso));

  // Total balance across active loans — header hero. Completed loans are
  // settled so they don't contribute to "what you owe right now".
  const totalBalance = activeLoans.reduce(
    (sum, l) => sum + l.currentBalanceUsd,
    0
  );

  const upcoming = activeLoans
    .filter((l) => inFilter(l, upcomingFilter))
    .sort(
      (a, b) =>
        daysFromTodayLocal(a.nextPaymentDateIso) -
        daysFromTodayLocal(b.nextPaymentDateIso)
    );
  const upcomingTotal = upcoming.reduce(
    (sum, l) => sum + l.monthlyPaymentUsd,
    0
  );

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Dark navy hero — Plans title + total balance. Mirrors the real
          Affirm app's Plans tab so judges immediately recognize the screen
          and know servicing actions land here. */}
      <header
        className="px-4 pt-3 pb-10 text-white relative"
        style={{
          background:
            "linear-gradient(180deg, #0E1E5C 0%, #11236A 50%, #0A2540 100%)",
        }}
      >
        <div className="flex items-center justify-between">
          <button
            onClick={onBack}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 transition"
            aria-label="Back"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 transition opacity-90"
              onClick={() => {
                /* visual only in the demo */
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 transition"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mt-2 text-[24px] font-bold tracking-tight">Plans</div>

        <div className="mt-7 text-center">
          <div className="text-[14px] opacity-90 font-medium">
            Total balance
          </div>
          <div className="text-[44px] font-bold leading-tight tracking-tight mt-1">
            {formatMoneyM(totalBalance)}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto bg-white -mt-5 rounded-t-3xl pt-5 pb-8 relative z-10">
        {/* Active / Completed tabs — single source of state for the section
            below. Underline-only tabs, just like the real app. */}
        <div className="px-5 flex gap-7 border-b border-gray-100">
          {(["active", "completed"] as const).map((t) => {
            const isActive = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`pb-2.5 text-[15px] font-semibold transition relative ${
                  isActive ? "text-[#0A2540]" : "text-gray-400"
                }`}
              >
                {t === "active" ? "Active" : "Completed"}
                {isActive && (
                  <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-[#0A2540] rounded-full" />
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="px-4 mt-4">
            <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          </div>
        )}

        {loans === null && !error && (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-gray-300 border-t-[#6959F8] rounded-full animate-spin" />
          </div>
        )}

        {loans !== null && tab === "active" && (
          <>
            {/* "Ask the assistant" hero — the deliberate answer to the
                judge question "why isn't this just a smarter Manage tab?".
                This screen IS Manage. The agent is the verb layer that
                runs on top: structured UI shows state, agent reasons
                across that state ("I'm short this month — what should I
                move first?") and authorizes actions with Face ID. The
                CTA opens chat with no prefill so the user can drive a
                cross-plan question that no structured tab can answer.
                Per-plan entries (Pay off / Reschedule / Pay early below)
                already cover the targeted action case. */}
            <div className="px-4 mt-4">
              <button
                type="button"
                onClick={() => onOpenChatWith("")}
                className="w-full rounded-2xl text-left px-4 py-3.5 text-white shadow-sm hover:opacity-95 transition"
                style={{
                  background:
                    "linear-gradient(135deg, #6959F8 0%, #4A3BB8 100%)",
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-bold leading-tight">
                      Ask the assistant
                    </div>
                    <div className="text-[11px] opacity-90 mt-0.5 leading-snug">
                      Reason across plans, reschedule, or pay off — Face ID authorizes.
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </button>
              <div className="text-center mt-1.5">
                <a
                  href="/about"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-gray-400 hover:text-[#6959F8] underline underline-offset-2 transition"
                >
                  About this build · architecture & scope
                </a>
              </div>
            </div>

            {/* Plan policy panel — keep this; it's what makes the
                approved-vs-denied contrast feel principled rather than
                arbitrary. Compact pill above Upcoming so the section header
                still anchors the screen. */}
            <div className="px-4 mt-4">
              <div className="rounded-xl bg-[#0A2540] text-white px-3 py-2.5 flex items-start gap-2">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5 shrink-0"
                >
                  <path d="M9 12l2 2 4-4" />
                  <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" />
                </svg>
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wide font-bold opacity-80">
                    Plan policy
                  </div>
                  <div className="text-[12px] leading-snug mt-0.5">
                    Reschedules: up to {RESCHEDULE_WINDOW_DAYS_DISPLAY} days
                    past due. Each upcoming payment can be moved once.
                    Payoffs and pay-early always available.
                  </div>
                </div>
              </div>
            </div>

            {/* Upcoming payments — by far the most-glanced section in the
                real Plans tab. Pill button on the right routes the user
                back into chat with a pay-installment intent prefilled, so
                the same Face ID + policy engine path runs. */}
            {activeLoans.length > 0 && (
              <section className="px-4 mt-5">
                <h2 className="text-[18px] font-bold text-[#0A2540] mb-3">
                  Upcoming payments
                </h2>
                <div className="flex gap-2 mb-3 overflow-x-auto -mx-1 px-1 pb-1">
                  {(
                    [
                      ["week", "This week"],
                      ["month", "This month"],
                      ["next", "Next month"],
                    ] as const
                  ).map(([key, label]) => {
                    const isActive = upcomingFilter === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setUpcomingFilter(key)}
                        className={`text-[12px] font-semibold px-3.5 py-1.5 rounded-full border transition whitespace-nowrap ${
                          isActive
                            ? "bg-[#0A2540] text-white border-[#0A2540]"
                            : "bg-white text-[#0A2540] border-gray-200 hover:border-[#0A2540]/40"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                {upcoming.length > 0 ? (
                  <>
                    <div className="text-[13px] text-gray-500 mb-2">
                      Total:{" "}
                      <span className="font-bold text-[#0A2540]">
                        {formatMoneyM(upcomingTotal)}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {upcoming.map((loan) => (
                        <UpcomingPaymentRow
                          key={loan.id}
                          loan={loan}
                          onPay={onOpenChatWith}
                          justUpdated={loan.id === recentlyUpdatedLoanId}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="text-[13px] text-gray-500 py-4">
                    No payments due {upcomingFilter === "week" ? "this week" : upcomingFilter === "month" ? "this month" : "next month"}.
                  </div>
                )}
              </section>
            )}

            {/* Current plans — same data the agent reads. Tap the action
                buttons to jump back into chat with that intent prefilled. */}
            <section className="px-4 mt-7">
              <h2 className="text-[18px] font-bold text-[#0A2540] mb-3">
                Current plans
              </h2>
              {activeLoans.length === 0 ? (
                <div className="text-[13px] text-gray-500 text-center py-8">
                  No active plans.
                </div>
              ) : (
                <div className="space-y-3">
                  {activeLoans.map((loan) => (
                    <LoanCard
                      key={loan.id}
                      loan={loan}
                      justUpdated={loan.id === recentlyUpdatedLoanId}
                      onAction={(prefill) => onOpenChatWith(prefill)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {loans !== null && tab === "completed" && (
          <section className="px-4 mt-5">
            {completedLoans.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-[14px] text-gray-500">
                  No completed plans yet.
                </div>
                <div className="text-[12px] text-gray-400 mt-1">
                  Pay off a plan from the Active tab and it will show up here.
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {completedLoans.map((loan) => (
                  <LoanCard
                    key={loan.id}
                    loan={loan}
                    justUpdated={loan.id === recentlyUpdatedLoanId}
                    onAction={(prefill) => onOpenChatWith(prefill)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {loans && loans.length > 0 && (
          <div className="px-4 mt-6">
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting}
              className="w-full py-2.5 rounded-xl text-[13px] text-gray-500 border border-dashed border-gray-300 hover:bg-gray-50 hover:text-[#0A2540] transition disabled:opacity-50"
            >
              {resetting ? "Resetting…" : "Reset demo state"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

/** Money formatter for the Manage screen (matches chat card formatting). */
function formatMoneyM(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * APR display helper. Affirm shows APR with two decimals when the value
 * isn't a whole percent (e.g. 21.99%) and as an integer when it is (15%,
 * 0%). Rendered as a small chip on plan rows so the user can compare
 * cost-to-carry across plans without doing math.
 */
function formatAprBps(bps: number): string {
  if (bps === 0) return "0% APR";
  const pct = bps / 100;
  return `${pct.toFixed(bps % 100 === 0 ? 0 : 2)}% APR`;
}

/**
 * APR chip. Color-coded by interest level so the user can scan a list of
 * plans and immediately spot the expensive ones — that's the lens the
 * optimization tool uses internally and the chip surfaces it on every row.
 *   - 0% APR        → green (no interest cost)
 *   - <10% APR      → slate (low cost)
 *   - 10–20% APR    → amber (notable cost)
 *   - 20%+ APR      → orange (highest cost; flag for paydown)
 */
function AprChip({ bps, size = "sm" }: { bps: number; size?: "sm" | "xs" }) {
  if (bps < 0) return null;
  const tone =
    bps === 0
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : bps < 1000
      ? "bg-slate-50 text-slate-700 border-slate-200"
      : bps < 2000
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-orange-50 text-orange-800 border-orange-200";
  const padding = size === "xs" ? "px-1.5 py-px" : "px-2 py-0.5";
  const text = size === "xs" ? "text-[10px]" : "text-[11px]";
  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full border ${tone} ${padding} ${text}`}
    >
      {formatAprBps(bps)}
    </span>
  );
}

function LoanCard({
  loan,
  justUpdated,
  onAction,
}: {
  loan: LoanView;
  justUpdated: boolean;
  onAction: (prefill: string) => void;
}) {
  const isPaidOff = loan.status === "paid_off";
  const status = nextPaymentStatusLabel(loan.nextPaymentDateIso);

  const borderClass = justUpdated
    ? "border-[#6959F8] ring-2 ring-[#6959F8]/30 shadow-md"
    : "border-gray-200";

  // Mirror the real Plans card: merchant logo + name on the left, balance
  // on the right, status line below the merchant. No internal loan IDs.
  return (
    <div
      className={`bg-white border rounded-2xl overflow-hidden transition ${borderClass}`}
    >
      <div className="px-4 py-3.5 flex items-center gap-3">
        <MerchantLogo
          domain={loan.merchantDomain}
          name={loan.merchant}
          size={40}
          paidOff={isPaidOff}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[16px] font-bold text-[#0A2540]">
              {loan.merchant}
            </span>
            {justUpdated && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-[#6959F8] text-white animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-white" />
                Just updated
              </span>
            )}
          </div>
          {isPaidOff ? (
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span className="text-[12px] text-emerald-700 font-semibold">
                Paid in full
              </span>
              {loan.paidOffDateLabel && (
                <span className="text-[12px] text-gray-500">
                  · {loan.paidOffDateLabel}
                </span>
              )}
              {loan.payoffMethod === "early" && (
                <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                  Paid early
                </span>
              )}
            </div>
          ) : (
            <div
              className={`text-[12px] mt-0.5 ${
                status.isOverdue ? "text-red-600 font-semibold" : "text-gray-500"
              }`}
            >
              {status.label || `Next: ${loan.nextPaymentLabel}`}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[16px] font-bold text-[#0A2540] leading-tight">
            {/* For closed plans show the original financed amount — that's
                the number the user remembers. $0.00 "settled" tells them
                nothing they didn't already infer from "Paid in full". */}
            {isPaidOff
              ? formatMoneyM(loan.originalBalanceUsd)
              : formatMoneyM(loan.currentBalanceUsd)}
          </div>
          <div className="text-[11px] text-gray-500">
            {isPaidOff ? "financed" : "remaining"}
          </div>
        </div>
      </div>

      {!isPaidOff && (
        <div className="px-4 pb-3 -mt-1 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-gray-500">
            {formatMoneyM(loan.monthlyPaymentUsd)}/mo ·{" "}
            {loan.monthsRemaining} payments left
          </span>
          <AprChip bps={loan.aprBps} size="xs" />
        </div>
      )}

      {isPaidOff && loan.originalTermMonths > 0 && (
        <div className="px-4 pb-3 text-[11px] text-gray-500 -mt-1">
          {formatMoneyM(loan.monthlyPaymentUsd)}/mo over{" "}
          {loan.originalTermMonths} months
        </div>
      )}

      {/* Activity timeline — appears once the user has done something to
          this plan. No ref IDs in user-facing copy; agent surfaces those
          separately when needed. */}
      {loan.activity.length > 0 && (
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/60">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
            Recent activity
          </div>
          <ul className="space-y-1.5">
            {loan.activity.map((a) => (
              <li
                key={a.refId}
                className="flex items-start gap-2 text-[12px] text-[#0A2540]"
              >
                <ActivityDot kind={a.kind} />
                <div className="flex-1 leading-snug">{a.description}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Action chips — same intents as the upcoming pay button but for
          payoff / reschedule. Tapping routes back to chat with the prefill
          so the demo can show off the routing + Face ID flow from any
          surface. */}
      {!isPaidOff && (
        <div className="px-4 py-3 border-t border-gray-100 flex gap-2">
          <button
            type="button"
            onClick={() =>
              onAction(`I want to pay off my ${loan.merchant} loan in full.`)
            }
            className="flex-1 py-2 rounded-full bg-white border border-gray-200 text-[12px] font-semibold text-[#0A2540] hover:border-[#0A2540]/40 transition"
          >
            Pay off
          </button>
          <button
            type="button"
            onClick={() =>
              onAction(`I want to reschedule my next ${loan.merchant} payment.`)
            }
            className="flex-1 py-2 rounded-full bg-white border border-gray-200 text-[12px] font-semibold text-[#0A2540] hover:border-[#0A2540]/40 transition"
          >
            Reschedule
          </button>
          <button
            type="button"
            onClick={() =>
              onAction(`I want to pay an extra ${loan.merchant} installment now.`)
            }
            className="flex-1 py-2 rounded-full bg-white border border-gray-200 text-[12px] font-semibold text-[#0A2540] hover:border-[#0A2540]/40 transition"
          >
            Pay early
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityDot({ kind }: { kind: LoanActivityKind }) {
  const color =
    kind === "paid_off"
      ? "#10b981" // emerald
      : kind === "rescheduled"
      ? "#6959F8" // accent
      : "#0A2540";
  return (
    <span
      className="w-1.5 h-1.5 rounded-full mt-[7px] shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

type LoanActivityKind = LoanOverride["kind"];

function PurchaseExplainer({
  planLabel,
  price,
  onCancel,
  onContinue,
}: {
  planLabel: string;
  price?: number;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const steps = [
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l2.39 7.36H22l-6.2 4.5 2.4 7.36L12 16.72 5.8 21.22l2.4-7.36L2 9.36h7.61z" />
        </svg>
      ),
      bg: ACCENT,
      title: "Affirm Agent finds your item",
      desc: "Searches the merchant's live product catalog on your behalf — real products, real prices.",
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" />
        </svg>
      ),
      bg: "#0A2540",
      title: "Affirm issues a virtual Visa card",
      desc: "Affirm generates a one-time virtual card tied to your plan. Your financing is locked in before checkout begins.",
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 01-8 0" />
        </svg>
      ),
      bg: "#059669",
      title: "Merchant processes a standard card payment",
      desc: "The virtual card completes checkout through Shopify's existing payment flow. The merchant sees a normal Visa transaction — no Affirm integration, no custom setup.",
    },
  ];

  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-white rounded-t-[28px] px-5 pt-5 pb-8 shadow-2xl"
        style={{ animation: "slideUp 220ms ease-out" }}
      >
        <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-5" />

        {/* Header */}
        <div className="mb-5">
          <div className="text-[11px] text-gray-400 uppercase tracking-wide font-medium mb-0.5">
            How it works
          </div>
          <div className="text-[20px] font-bold text-[#0A2540] leading-snug">
            Agent checkout — no merchant setup required
          </div>
        </div>

        {/* 3 steps */}
        <div className="space-y-4 mb-6">
          {steps.map((step, i) => (
            <div key={i} className="flex items-start gap-3.5">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: step.bg }}
              >
                {step.icon}
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <div className="text-[14px] font-semibold text-[#0A2540] leading-snug">
                  {step.title}
                </div>
                <div className="text-[12px] text-gray-500 mt-0.5 leading-relaxed">
                  {step.desc}
                </div>
              </div>
              {i < steps.length - 1 && (
                <div className="absolute" />
              )}
            </div>
          ))}
        </div>

        {/* Platform note */}
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[#F5F5F7] mb-5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>
          <span className="text-[12px] text-gray-500 leading-relaxed">
            Works at any Shopify merchant today — 150,000+ stores. Extends to platforms with open cart APIs (Stripe ACP next).
          </span>
        </div>

        {/* Plan summary */}
        {typeof price === "number" && (
          <div className="flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 bg-white mb-4">
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide font-medium">Your plan</div>
              <div className="text-[15px] font-bold text-[#0A2540] mt-0.5">{planLabel}</div>
            </div>
            <div className="text-[18px] font-bold text-[#0A2540]">
              ${price.toLocaleString()}
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-3.5 rounded-full border border-gray-200 font-semibold text-[#0A2540] text-[15px]"
          >
            Cancel
          </button>
          <button
            onClick={onContinue}
            className="flex-1 py-3.5 rounded-full font-semibold text-white text-[15px]"
            style={{ background: ACCENT }}
          >
            Confirm with Face ID
          </button>
        </div>
      </div>
    </div>
  );
}

function BiometricGate({ planLabel, price, onCancel, onSuccess }: { planLabel: string; price?: number; onCancel: () => void; onSuccess: () => void }) {
  const [status, setStatus] = useState<"idle" | "scanning" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  async function runBiometric() {
    setStatus("scanning"); setErrorMsg(null);
    try {
      if (typeof window !== "undefined" && window.PublicKeyCredential) {
        const challenge = new Uint8Array(32);
        crypto.getRandomValues(challenge);
        const cred = await navigator.credentials.create({ publicKey: { challenge, rp: { name: "Affirm" }, user: { id: new TextEncoder().encode(`purchase-${Date.now()}`), name: "james@affirm.com", displayName: "James" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" }, timeout: 30000 } });
        if (!cred) throw new Error("No credential");
      } else { await new Promise((r) => setTimeout(r, 1500)); }
      setStatus("success"); setTimeout(() => onSuccess(), 600);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error && err.name === "NotAllowedError" ? "Authentication canceled" : "Couldn't verify — try again");
    }
  }
  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm" onClick={() => status === "idle" && onCancel()}>
      <div onClick={(e) => e.stopPropagation()} className="w-full bg-white rounded-t-[28px] px-6 pt-5 pb-8 shadow-2xl" style={{ animation: "slideUp 200ms ease-out" }}>
        <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-5" />
        <div className="text-center">
          <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Confirm purchase</div>
          <div className="text-[22px] font-bold text-[#0A2540] mt-1">{planLabel}</div>
          {typeof price === "number" && <div className="text-[14px] text-gray-500 mt-0.5">${price.toLocaleString()} total</div>}
        </div>
        <div className="mt-6 flex flex-col items-center">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center transition ${status === "scanning" ? "animate-pulse" : ""} ${status === "success" ? "bg-green-500" : ""}`}
            style={status === "success" ? undefined : { background: status === "error" ? "#fee2e2" : `linear-gradient(135deg, ${ACCENT} 0%, #9B8DF8 100%)` }}
          >
            {status === "success" ? (
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            ) : status === "error" ? (
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
            ) : (
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 11a4 4 0 014 4v3" /><path d="M8 18v-3a4 4 0 014-4" /><path d="M4 10a8 8 0 0116 0v2a12 12 0 01-.5 3.5" /><path d="M8.5 21a16 16 0 01-1-6 4.5 4.5 0 019 0" />
              </svg>
            )}
          </div>
          <div className="mt-4 text-[14px] font-medium text-[#0A2540] text-center min-h-[20px]">
            {status === "idle" && "Tap to confirm with Face ID"}
            {status === "scanning" && "Verifying…"}
            {status === "success" && "Confirmed — placing your order"}
            {status === "error" && errorMsg}
          </div>
        </div>
        <div className="mt-6 flex gap-2">
          <button onClick={onCancel} disabled={status === "scanning" || status === "success"} className="flex-1 py-3.5 rounded-full border border-gray-200 font-semibold text-[#0A2540] disabled:opacity-40">Cancel</button>
          <button onClick={runBiometric} disabled={status === "scanning" || status === "success"} className="flex-1 py-3.5 rounded-full font-semibold text-white disabled:opacity-60" style={{ background: ACCENT }}>
            {status === "error" ? "Try again" : "Confirm with Face ID"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-2 pb-8">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4" style={{ background: `linear-gradient(135deg, ${ACCENT} 0%, #9B8DF8 100%)` }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l2.39 7.36H22l-6.2 4.5 2.4 7.36L12 16.72 5.8 21.22l2.4-7.36L2 9.36h7.61z" />
        </svg>
      </div>
      <h2 className="text-[20px] font-bold text-[#0A2540] mb-1.5 text-center leading-tight">
        Manage your plans, not just ask about them
      </h2>
      <p className="text-[14px] text-gray-500 text-center mb-4 max-w-[320px] leading-snug">
        Tell me what&apos;s going on. I&apos;ll reason across all your plans, surface what&apos;s eligible, and authorize with Face ID:
      </p>
      <div className="w-full space-y-2">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="w-full text-left px-4 py-3 text-[14px] text-[#0A2540] bg-white border border-gray-200 hover:bg-gray-50 hover:border-[#6959F8]/40 rounded-2xl transition shadow-sm flex items-start gap-3"
          >
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0 mt-0.5"
              style={{ background: ACCENT }}
            >
              {i + 1}
            </span>
            <span className="flex-1">{s}</span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-gray-400 text-center mt-3 leading-snug max-w-[320px]">
        Tap the help icon at the top right for the architecture story.
      </p>
    </div>
  );
}

type Plan = { id: string; label: string; total_payments: number; cadence: string; apr: number; monthly_payment_usd: number; total_cost_usd: number };
type ActivePlan = { id: string; merchant: string; merchant_domain?: string; balance_usd: number; monthly_payment_usd: number; months_remaining: number; apr_bps?: number; next_payment_date?: string };
type CreditSummaryResult = { user_first_name: string; available_credit_usd: number; active_plans: ActivePlan[]; total_monthly_obligation_usd: number };
type Product = { id: string; merchant_id: string; merchant: string; title: string; price: number; description?: string; url?: string; image_url?: string; product_type?: string };
type SearchResult = { query?: string; result_count?: number; results: Product[] };
type PurchaseResult = {
  status?: string; confirmation_code?: string;
  platform?: "shopify" | "web";
  product?: { id: string; title: string; merchant: string; price_usd: number; image_url?: string | null; url?: string };
  plan?: { id: string; label: string; cadence: "biweekly" | "monthly"; apr: number; total_payments: number; monthly_payment_usd: number; total_cost_usd: number; first_payment_date: string };
  plan_id?: string; estimated_delivery?: string;
  email?: { status: "sent"; to: string } | { status: "skipped"; reason: string } | { status: "failed"; error: string };
  message?: string; error?: string;
};

type ServicingPayoffQuoteResult =
  | {
      ok: true;
      loan_id: string;
      merchant: string;
      payoff_usd: number;
      good_through: string;
      funding_sources: { id: string; label: string }[];
      policy_note?: string;
    }
  | { error: string; message: string };

type ServicingEmailStatus = {
  status: "sent" | "skipped" | "error";
  to: string;
  message?: string;
};

type ServicingReschedulePreviewResult =
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
      request_outcome: "approved" | "blocked" | null;
      policy_note?: string;
    }
  | { error: string; message: string };

type ServicingRefundCaseResult =
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

type TriagePlanRow = {
  loan_id: string;
  merchant: string;
  merchant_domain: string;
  next_due_iso: string;
  next_due_label: string;
  days_until_due: number;
  monthly_payment_usd: number;
  apr_bps: number;
  reschedule_eligible: boolean;
  reschedule_block_code?: string;
  reschedule_block_reason?: string;
  latest_eligible_iso?: string;
  latest_eligible_label?: string;
};

type TriageRecommendation =
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
    };

type ServicingTriageResult =
  | {
      ok: true;
      total_due_window_usd: number;
      window_label: string;
      plans: TriagePlanRow[];
      recommended: TriageRecommendation | null;
      policy_note: string;
    }
  | { error: string; message: string };

type OptimizationStrategy =
  | "save_interest"
  | "clear_plan"
  | "free_cash_flow"
  | "allocate_across";

type AllocationLeg = {
  loan_id: string;
  merchant: string;
  merchant_domain: string;
  apply_amount_usd: number;
  closes_plan: boolean;
  apr_bps: number;
};

type OptimizationOption = {
  rank: number;
  strategy: OptimizationStrategy;
  loan_id: string;
  merchant: string;
  merchant_domain: string;
  apr_bps: number;
  apply_amount_usd: number;
  leftover_usd: number;
  remaining_balance_after_usd: number;
  closes_plan: boolean;
  est_interest_saved_usd: number;
  est_months_saved: number;
  headline: string;
  rationale: string;
  allocation_legs?: AllocationLeg[];
  plans_closed_count?: number;
};

type ServicingOptimizationResult =
  | {
      ok: true;
      hypothetical_amount_usd: number;
      options: OptimizationOption[];
      policy_note: string;
    }
  | { error: string; message: string };

function formatMoney(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ServicingPayoffQuoteCard({
  data,
  blockId,
  state,
  onConfirm,
}: {
  data: Extract<ServicingPayoffQuoteResult, { ok: true }>;
  blockId: string;
  state: BiometricExecutionState;
  onConfirm: (
    blockId: string,
    action: Extract<ServicingActionParams, { kind: "payoff" }>
  ) => void;
}) {
  const gt = new Date(data.good_through);
  const [selectedFs, setSelectedFs] = useState(
    data.funding_sources[0]?.id ?? ""
  );
  const phase = state.phase;
  const buttonDisabled =
    phase === "authenticating" || phase === "submitting" || phase === "done";

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100" style={{ background: `linear-gradient(135deg, ${ACCENT} 0%, #4A3BB8 100%)` }}>
        <div className="text-[11px] uppercase tracking-wide text-white/80 font-medium">Payoff quote</div>
        <div className="text-[22px] font-bold text-white mt-0.5">{formatMoney(data.payoff_usd)}</div>
        <div className="text-[12px] text-white/85 mt-1">{data.merchant}</div>
      </div>
      <div className="px-4 py-3 space-y-3 text-[13px] text-[#0A2540]">
        <div className="text-gray-500 text-[12px]">Good through {gt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">
              Funding source
            </div>
            <div className="text-[10px] text-gray-400">Tap to choose</div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.funding_sources.map((f) => {
              const active = f.id === selectedFs;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedFs(f.id)}
                  disabled={buttonDisabled}
                  aria-pressed={active}
                  className={`text-[12px] px-3 py-1.5 rounded-full border-2 font-semibold transition disabled:opacity-50 flex items-center gap-1.5 ${
                    active
                      ? "bg-[#0A2540] text-white border-[#0A2540] shadow-sm"
                      : "bg-white text-[#0A2540] border-[#6959F8]/30 hover:border-[#6959F8] hover:bg-[#EAE7F9]"
                  }`}
                >
                  {active && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
        <BiometricConfirmButton
          label="Confirm payoff with Face ID"
          state={state}
          disabled={!selectedFs}
          onClick={() =>
            onConfirm(blockId, {
              kind: "payoff",
              loan_id: data.loan_id,
              funding_source_id: selectedFs,
            })
          }
        />
      </div>
    </div>
  );
}

/**
 * Default funding source for the "pay installment instead" pivot. Real product
 * would surface the user's autopay funding here. The mock servicing engine
 * accepts either fs_debit_442 or fs_bank_901; debit is the demo default.
 */
const DEFAULT_INSTALLMENT_FS_ID = "fs_debit_442";
const DEFAULT_INSTALLMENT_FS_LABEL = "debit •••442";

// Display constant — kept in sync with RESCHEDULE_POLICY.windowDays in
// app/lib/mockData.ts. The page.tsx server type bundle doesn't pull
// RESCHEDULE_POLICY directly to keep client/server boundaries clean, so we
// hardcode the display value here. If the policy ever changes, update both.
const RESCHEDULE_WINDOW_DAYS_DISPLAY = 14;

/**
 * Refund case card. Affirm doesn't issue refunds itself — the merchant does.
 * What we own is the loan: autopay pauses while merchant reviews; principal
 * adjusts when refund posts. This card surfaces both halves and a deep-link
 * to the merchant. No biometric needed — it's a case open, not a money move.
 */
function ServicingRefundCaseCard({
  data,
}: {
  data: Extract<ServicingRefundCaseResult, { ok: true }>;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100" style={{ background: "linear-gradient(135deg, #2A66E0 0%, #6959F8 100%)" }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-white/80 font-medium">Refund case opened</div>
            <div className="text-[15px] font-semibold text-white mt-0.5 truncate">{data.merchant} · {data.product_title}</div>
            <div className="text-[12px] text-white/80 mt-0.5">Purchased {data.purchased_label}</div>
          </div>
          <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-1 rounded bg-white/15 text-white border border-white/20 shrink-0 font-mono">
            {data.case_id}
          </span>
        </div>
      </div>
      <div className="px-4 py-3 space-y-3 text-[13px] text-[#0A2540]">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Remaining balance</div>
            <div className="text-[16px] font-bold text-[#0A2540] mt-0.5">{formatMoney(data.remaining_balance_usd)}</div>
            <div className="text-[11px] text-gray-500">{formatMoney(data.monthly_payment_usd)}/mo</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Autopay paused until</div>
            <div className="text-[16px] font-bold text-[#0A2540] mt-0.5">{data.autopay_paused_until_label}</div>
            <div className="text-[11px] text-gray-500">Next due was {data.next_due_label}</div>
          </div>
        </div>
        <div className="rounded-xl bg-blue-50 border border-blue-100 px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide font-semibold text-blue-900 mb-1">What happens next</div>
          <div className="text-[12px] text-blue-950 leading-snug">
            Reach out to {data.merchant} to start the refund. Once they confirm, your remaining balance will be adjusted automatically and autopay resumes. We'll email you when we post the adjustment.
          </div>
        </div>
        <a
          href={data.contact_url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full py-2.5 rounded-xl text-white font-semibold text-[14px] transition flex items-center justify-center gap-2"
          style={{ background: ACCENT }}
        >
          <span>{data.contact_label}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17L17 7" /><path d="M7 7h10v10" />
          </svg>
        </a>
      </div>
    </div>
  );
}

function ServicingReschedulePreviewCard({
  data,
  blockId,
  state,
  onConfirm,
}: {
  data: Extract<ServicingReschedulePreviewResult, { ok: true }>;
  blockId: string;
  state: BiometricExecutionState;
  onConfirm: (
    blockId: string,
    action:
      | Extract<ServicingActionParams, { kind: "reschedule" }>
      | Extract<ServicingActionParams, { kind: "pay_installment" }>
  ) => void;
}) {
  const targets = data.allowed_reschedule_targets;
  // If the policy engine approved the user's specific request, pre-select that
  // date so the user can tap Confirm without re-picking.
  const initialIso =
    data.request_outcome === "approved" && data.requested_date_iso
      ? data.requested_date_iso
      : targets[0]?.iso ?? "";
  const [selectedIso, setSelectedIso] = useState(initialIso);
  const phase = state.phase;
  const disabled =
    phase === "authenticating" || phase === "submitting" || phase === "done";

  // When the user's requested date was outside the policy window, the preview
  // returns a blocked_request. This is the "approved vs denied based on real
  // plan state" moment — but the framing matters for compliance. We DON'T
  // call this "Denied" or "Not eligible" because either reads like adverse
  // action under Reg B / ECOA. It isn't — the loan terms aren't changing,
  // the user's credit isn't being denied. The self-serve servicing channel
  // has an operational limit (1 reschedule per upcoming payment) the same
  // way a deposit account has "1 free transfer per month." We frame it as a
  // self-serve channel limit and ALWAYS offer two paths forward: the
  // pay-early pivot (action loop preserved in chat), and a real escape
  // hatch to human servicing. Users never hit a dead-end.
  if (data.blocked_request) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="px-4 py-3 bg-[#0A2540] flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-white/70 font-medium">Reschedule preview</div>
            <div className="text-[15px] font-semibold text-white mt-0.5">{data.merchant}</div>
            <div className="text-[12px] text-white/80">Current due {data.current_due_label} · Next installment {formatMoney(data.next_installment_usd)}</div>
          </div>
          <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-1 rounded bg-amber-400/20 text-amber-200 border border-amber-400/40 shrink-0">
            Self-serve limit
          </span>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-200 text-amber-900">
                {data.blocked_request.code}
              </span>
              <span className="text-[11px] uppercase tracking-wide font-semibold text-amber-900">
                Self-serve policy
              </span>
            </div>
            <div className="text-[13px] text-amber-950 leading-snug">
              {data.blocked_request.message}
            </div>
          </div>
          <div className="text-[12px] text-gray-600 leading-snug">
            Two paths from here — pay this installment now to stay current,
            or talk to a servicing rep for an exception.
          </div>
          <BiometricConfirmButton
            label={`Pay ${formatMoney(data.next_installment_usd)} now with Face ID`}
            state={state}
            disabled={false}
            onClick={() =>
              onConfirm(blockId, {
                kind: "pay_installment",
                loan_id: data.loan_id,
                amount_usd: data.next_installment_usd,
                funding_source_id: DEFAULT_INSTALLMENT_FS_ID,
              })
            }
          />
          {/* Real escape hatch — a context-loaded /help URL. The query
              params (topic + reason code + merchant) signal what the user
              is asking about; in production those would deep-link the
              servicing chat to the right plan with the right context
              already loaded. The point isn't to take the user away — it's
              to prove the design never traps them, and to demonstrate
              the integration shape the v1 ship would use. */}
          <a
            href={`https://www.affirm.com/help/contact?topic=reschedule&reason=${encodeURIComponent(
              data.blocked_request.code
            )}&plan=${encodeURIComponent(data.merchant)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center py-2 rounded-xl bg-white text-[#0A2540] border border-gray-300 hover:border-[#0A2540]/60 hover:bg-gray-50 text-[13px] font-semibold transition"
          >
            Talk to a rep about {data.merchant}
          </a>
          <div className="text-[10px] text-gray-400 text-center -mt-1.5 leading-snug">
            Opens Affirm support pre-loaded with this plan + reason
          </div>
        </div>
      </div>
    );
  }

  // Only show the green "Eligible" badge if the policy engine actually
  // approved the user's specific requested date. If they just asked for
  // options without naming a date, render a neutral header — we haven't
  // run a decision yet.
  const showApprovedBadge = data.request_outcome === "approved";

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-[#0A2540] flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-white/70 font-medium">Reschedule preview</div>
          <div className="text-[15px] font-semibold text-white mt-0.5">{data.merchant}</div>
          <div className="text-[12px] text-white/80">Current due {data.current_due_label} · Next installment {formatMoney(data.next_installment_usd)}</div>
        </div>
        {showApprovedBadge && (
          <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-1 rounded bg-emerald-400/20 text-emerald-200 border border-emerald-400/40 shrink-0">
            Eligible
          </span>
        )}
      </div>
      <div className="px-4 py-3 space-y-3">
        {showApprovedBadge && data.requested_date_label && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-200 text-emerald-900">
                RSH-OK
              </span>
              <span className="text-[11px] uppercase tracking-wide font-semibold text-emerald-900">
                Policy decision
              </span>
            </div>
            <div className="text-[13px] text-emerald-950 leading-snug">
              {data.requested_date_label} is within the {RESCHEDULE_WINDOW_DAYS_DISPLAY}-day window and you haven&apos;t yet moved this upcoming payment.
            </div>
          </div>
        )}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">
              Pick a new due date
            </div>
            <div className="text-[10px] text-gray-400">Tap to choose</div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t) => {
              const active = t.iso === selectedIso;
              return (
                <button
                  key={t.iso}
                  type="button"
                  onClick={() => setSelectedIso(t.iso)}
                  disabled={disabled}
                  aria-pressed={active}
                  className={`text-[12px] px-3 py-1.5 rounded-full border-2 font-semibold transition disabled:opacity-50 flex items-center gap-1.5 ${
                    active
                      ? "bg-[#0A2540] text-white border-[#0A2540] shadow-sm"
                      : "bg-white text-[#0A2540] border-[#6959F8]/30 hover:border-[#6959F8] hover:bg-[#EAE7F9]"
                  }`}
                >
                  {active && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        {data.policy_note && (
          <div className="text-[11px] text-gray-400">{data.policy_note}</div>
        )}
        <BiometricConfirmButton
          label="Confirm new date with Face ID"
          state={state}
          disabled={!selectedIso}
          onClick={() =>
            onConfirm(blockId, {
              kind: "reschedule",
              loan_id: data.loan_id,
              new_date_iso: selectedIso,
            })
          }
        />
      </div>
    </div>
  );
}

/**
 * Reusable biometric CTA. Renders the right state for each phase of the
 * authorization lifecycle so quote/preview cards don't re-implement it.
 */
function BiometricConfirmButton({
  label,
  state,
  disabled,
  onClick,
}: {
  label: string;
  state: BiometricExecutionState;
  disabled: boolean;
  onClick: () => void;
}) {
  const phase = state.phase;
  const isBusy = phase === "authenticating" || phase === "submitting";
  const isDone = phase === "done";

  if (isDone) {
    return (
      <div className="w-full py-2.5 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-200 text-[13px] font-semibold flex items-center justify-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        Authorized — see receipt below
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || isBusy}
        className="w-full py-2.5 rounded-xl text-white font-semibold text-[14px] transition disabled:opacity-50 flex items-center justify-center gap-2"
        style={{ background: ACCENT }}
      >
        {isBusy ? (
          <>
            <span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            <span>{phase === "authenticating" ? "Waiting for Face ID…" : "Submitting…"}</span>
          </>
        ) : (
          <>
            <FaceIdIcon />
            <span>{label}</span>
          </>
        )}
      </button>
      {phase === "error" && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 flex items-start gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="text-[12px] text-red-800 leading-snug">
            <div className="font-semibold">Couldn't complete that action</div>
            <div className="mt-0.5">{state.message} Tap the button again to retry.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function FaceIdIcon() {
  // Stylized Face ID glyph: face contour with the four corner brackets that
  // Apple uses for the Face ID system icon. Pure SVG so it picks up the
  // button's currentColor.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <line x1="9" y1="9" x2="9" y2="11" />
      <line x1="15" y1="9" x2="15" y2="11" />
      <path d="M12 9v3.5" />
      <path d="M9.5 15c.7.6 1.6 1 2.5 1s1.8-.4 2.5-1" />
    </svg>
  );
}

function ServicingSuccessCard({
  title,
  referenceId,
  subtitle,
  email,
  policyCode,
  onViewInManage,
}: {
  title: string;
  referenceId: string;
  subtitle: string;
  email?: ServicingEmailStatus;
  policyCode?: string;
  onViewInManage?: () => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-5 py-4 text-white" style={{ background: "linear-gradient(135deg, #0f7a4e 0%, #16a870 100%)" }}>
        <div className="text-[11px] uppercase tracking-wide opacity-90 font-medium">{title}</div>
        <div className="font-mono text-[18px] font-bold mt-1">{referenceId}</div>
      </div>
      <div className="px-5 py-3 text-[13px] text-[#0A2540] leading-relaxed">{subtitle}</div>
      {/* Policy + auth provenance chip — makes the architectural story visible
          on every successful action, not just denials. Judges scanning the
          card see the deterministic policy decision AND the biometric step-up
          without having to read documentation. */}
      <div className="px-5 py-2 border-t border-gray-100 bg-[#0A2540]/[0.03] flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          {policyCode ?? "POLICY OK"}
        </span>
        <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-500">
          Authorized via Face ID
        </span>
      </div>
      {email && email.status === "sent" && (
        <div className="px-5 py-2.5 border-t border-gray-100 bg-gray-50 flex items-center gap-2 text-[12px] text-gray-600">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" />
          </svg>
          <span>Confirmation sent to <span className="font-medium text-[#0A2540]">{email.to}</span></span>
        </div>
      )}
      {onViewInManage && (
        <button
          type="button"
          onClick={onViewInManage}
          className="w-full px-5 py-3 border-t border-gray-100 text-[13px] font-semibold text-[#0A2540] hover:bg-gray-50 transition flex items-center justify-center gap-2"
        >
          <span>View in Manage</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ServicingErrorCard({ title, message, code }: { title: string; message: string; code?: string }) {
  return (
    <div className="rounded-2xl px-4 py-3 bg-red-50 border border-red-100">
      <div className="text-[12px] font-semibold text-red-800">{title}{code ? ` · ${code}` : ""}</div>
      <div className="text-[13px] text-red-900 mt-1 leading-snug">{message}</div>
    </div>
  );
}

/**
 * Cross-plan triage card. Surfaced when the user describes a cash-flow
 * constraint ("I'm going to be short this month") and the agent routes
 * the intent through `servicing_triage_options`.
 *
 * NOTE — why this response type has no equivalent in the Manage tab:
 * The Manage tab can list every loan, but it can't reason ACROSS loans.
 * Picking the right action for a cash shortfall requires:
 *   1. Sorting plans by next due date (which payment hits first?)
 *   2. Per-plan eligibility (which ones can still be rescheduled this
 *      cycle vs which have already burned their slot?)
 *   3. A recommendation joining (1) and (2): "Move the soonest plan
 *      that's still reschedule-eligible — that frees the most cash with
 *      the least policy cost."
 * That's a reasoning step the structured Manage UI cannot perform; it
 * just displays state. The triage card is the agent's contribution —
 * the same data, reorganized around a decision the user is trying to
 * make right now. If you ever ask "why isn't this just in Manage?",
 * the answer is here.
 */
function ServicingTriageCard({
  data,
  onPick,
}: {
  data: Extract<ServicingTriageResult, { ok: true }>;
  onPick: (text: string) => void;
}) {
  const rec = data.recommended;
  return (
    <div className="rounded-2xl bg-white border border-gray-200 overflow-hidden shadow-sm">
      <div
        className="px-4 py-3 text-white"
        style={{
          background: `linear-gradient(135deg, ${ACCENT} 0%, #4A3BB8 100%)`,
        }}
      >
        <div className="text-[10px] uppercase tracking-wide opacity-80 font-semibold">
          {data.window_label} · cash-flow snapshot
        </div>
        <div className="flex items-baseline gap-2 mt-0.5">
          <span className="text-[22px] font-bold leading-tight">
            {formatMoney(data.total_due_window_usd)}
          </span>
          <span className="text-[12px] opacity-90">due across {data.plans.length} plans</span>
        </div>
      </div>

      <ul className="divide-y divide-gray-100">
        {data.plans.map((p) => {
          const dayLabel =
            p.days_until_due < 0
              ? `Overdue ${Math.abs(p.days_until_due)}d`
              : p.days_until_due === 0
              ? "Due today"
              : `Due in ${p.days_until_due}d`;
          return (
            <li
              key={p.loan_id}
              className="px-4 py-3 flex items-center gap-3"
            >
              <MerchantLogo
                domain={p.merchant_domain}
                name={p.merchant}
                size={36}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-semibold text-[#0A2540] truncate">
                    {p.merchant}
                  </span>
                  <AprChip bps={p.apr_bps} size="xs" />
                  {p.reschedule_eligible ? (
                    <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                      Eligible
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                      Already moved
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-gray-500 mt-0.5">
                  {p.next_due_label} · {dayLabel}
                </div>
                {!p.reschedule_eligible && p.reschedule_block_reason && (
                  <div className="text-[11px] text-amber-700 mt-0.5 leading-snug">
                    {p.reschedule_block_reason}
                  </div>
                )}
                {p.reschedule_eligible && p.latest_eligible_label && (
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    Can move up to {p.latest_eligible_label}
                  </div>
                )}
              </div>
              <div className="text-[14px] font-bold text-[#0A2540] shrink-0">
                {formatMoney(p.monthly_payment_usd)}
              </div>
            </li>
          );
        })}
      </ul>

      {rec && (
        <div className="px-4 py-3 border-t border-gray-100 bg-[#F7F6FE]">
          <div className="flex items-center gap-2 mb-1">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke={ACCENT}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2l2.39 7.36H22l-6.2 4.5 2.4 7.36L12 16.72 5.8 21.22l2.4-7.36L2 9.36h7.61z" />
            </svg>
            <span
              className="text-[10px] uppercase tracking-wide font-bold"
              style={{ color: ACCENT }}
            >
              Recommended
            </span>
          </div>
          <div className="text-[13px] text-[#0A2540] leading-snug">
            {rec.kind === "reschedule" ? (
              <>
                Move <span className="font-semibold">{rec.merchant}</span>{" "}
                ({formatMoney(rec.monthly_payment_usd)}, due {rec.current_due_label}). You can push it up to{" "}
                <span className="font-semibold">{rec.latest_eligible_label}</span>.
              </>
            ) : (
              <>
                Pay <span className="font-semibold">{rec.merchant}</span>{" "}
                ({formatMoney(rec.monthly_payment_usd)}) early to clear the soonest payment.
              </>
            )}
          </div>
          <div className="text-[11px] text-gray-500 mt-1 leading-snug">
            {rec.rationale}
          </div>
          <div className="flex gap-2 mt-2.5">
            <button
              type="button"
              onClick={() =>
                onPick(
                  rec.kind === "reschedule"
                    ? `Reschedule my ${rec.merchant} payment.`
                    : `Pay an extra ${rec.merchant} installment now.`
                )
              }
              className="text-[12px] font-semibold text-white px-3.5 py-1.5 rounded-full hover:opacity-90 transition"
              style={{ background: ACCENT }}
            >
              {rec.kind === "reschedule"
                ? `Reschedule ${rec.merchant}`
                : `Pay ${rec.merchant} early`}
            </button>
            <button
              type="button"
              onClick={() => onPick(`Show me other options.`)}
              className="text-[12px] font-semibold text-[#0A2540] px-3.5 py-1.5 rounded-full border border-gray-200 hover:border-[#0A2540]/40 transition"
            >
              Other options
            </button>
          </div>
        </div>
      )}

      <div className="px-4 py-2 text-[10px] text-gray-400 leading-snug">
        {data.policy_note}
      </div>
    </div>
  );
}

/**
 * Cross-plan optimization card. Surfaced when the user asks where to put
 * EXTRA cash ("I have an extra $500 — what should I do with it?"). Mirror
 * of the triage card on the cash-surplus side.
 *
 * NOTE — why this response type also has no equivalent in the Manage tab:
 * Manage shows balances, APRs, and dates as separate columns. To answer
 * "where should I put $500" the user has to visually scan three columns
 * across N rows AND apply a goal weighting in their head — and most users
 * don't know that "highest APR" is usually the right economic answer. The
 * agent does the cross-column ranking + goal framing in one card so the
 * user picks by intent ("save interest" / "close a plan" / "free cash
 * flow"), not by spreadsheet logic.
 */
function ServicingOptimizationCard({
  data,
  onPick,
}: {
  data: Extract<ServicingOptimizationResult, { ok: true }>;
  onPick: (text: string) => void;
}) {
  const options = data.options;
  const top = options[0];
  const headlineCopy = top?.strategy === "allocate_across"
    ? `Top option closes ${top.plans_closed_count ?? 2} plans in one move.`
    : "Three options, three goals. Tap the one that fits.";
  return (
    <div className="rounded-2xl bg-white border border-gray-200 overflow-hidden shadow-sm">
      <div
        className="px-4 py-3 text-white"
        style={{
          background: `linear-gradient(135deg, ${ACCENT} 0%, #4A3BB8 100%)`,
        }}
      >
        <div className="text-[10px] uppercase tracking-wide opacity-80 font-semibold">
          Best use of {formatMoney(data.hypothetical_amount_usd)}
        </div>
        <div className="text-[14px] mt-0.5 opacity-95 leading-snug">
          {headlineCopy}
        </div>
      </div>

      <ul className="divide-y divide-gray-100">
        {options.map((o) => (
          <OptimizationOptionRow
            key={`${o.strategy}-${o.rank}`}
            option={o}
            isTop={top?.rank === o.rank}
            onPick={onPick}
          />
        ))}
      </ul>

      <div className="px-4 py-2 text-[10px] text-gray-400 leading-snug">
        {data.policy_note}
      </div>
    </div>
  );
}

/**
 * Single row of the optimization card. Branches on whether the option is a
 * single-plan move or a multi-plan allocation:
 *   - Single plan → merchant logo + headline + 1 CTA ("Apply to X")
 *   - allocate_across → no single logo (it's a portfolio move); instead,
 *     a stacked breakdown of legs with one CTA per leg. Each CTA fires
 *     the same per-plan action the user could trigger individually — so
 *     authorization stays on the existing single-plan WebAuthn surface
 *     and we don't need a "bulk authorize" path on the backend.
 */
function OptimizationOptionRow({
  option,
  isTop,
  onPick,
}: {
  option: OptimizationOption;
  isTop: boolean;
  onPick: (text: string) => void;
}) {
  const strategyLabel = strategyLabelFor(option.strategy);
  const strategyTone = strategyToneFor(option.strategy);
  const isAllocation =
    option.strategy === "allocate_across" &&
    option.allocation_legs &&
    option.allocation_legs.length > 0;

  // Visual hierarchy: the recommended option (rank 1) shows full detail —
  // strategy chip + RECOMMENDED + closes badges + headline + rationale +
  // allocation legs OR full metric row + CTA. Non-recommended options are
  // deliberately compact: strategy chip + headline + one metric line + CTA.
  // The headline is self-explanatory enough on its own ("Save ~$152 in
  // interest on Marriott" / "Close Nike today" / "Cover the next 6 Nike
  // payments") that repeating the rationale just adds noise the user has
  // to filter through. Cuts the card to roughly half its previous height.
  const showFullDetail = isTop;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        {isAllocation ? (
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ background: ACCENT }}
            aria-hidden
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M3 12h18" />
              <path d="M3 18h18" />
            </svg>
          </div>
        ) : (
          <MerchantLogo
            domain={option.merchant_domain}
            name={option.merchant}
            size={showFullDetail ? 36 : 32}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded ${strategyTone.chip}`}
            >
              {strategyLabel}
            </span>
            {isTop && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">
                Recommended
              </span>
            )}
            {showFullDetail && !isAllocation && option.closes_plan && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                Closes plan
              </span>
            )}
            {showFullDetail && isAllocation && typeof option.plans_closed_count === "number" && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                Closes {option.plans_closed_count} plans
              </span>
            )}
          </div>
          <div
            className={`font-semibold text-[#0A2540] mt-1 leading-snug ${
              showFullDetail ? "text-[14px]" : "text-[13px]"
            }`}
          >
            {option.headline}
          </div>
          {showFullDetail && (
            <div className="text-[12px] text-gray-600 mt-1 leading-snug">
              {option.rationale}
            </div>
          )}

          {isAllocation && option.allocation_legs ? (
            <AllocationBreakdown
              legs={option.allocation_legs}
              totalApplied={option.apply_amount_usd}
              leftover={option.leftover_usd}
              estInterestSaved={option.est_interest_saved_usd}
              onPick={onPick}
              isTop={isTop}
            />
          ) : showFullDetail ? (
            <SinglePlanFooter option={option} onPick={onPick} isTop={isTop} />
          ) : (
            <CompactSinglePlanFooter option={option} onPick={onPick} />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Compact metric + CTA row for non-recommended single-plan options. Picks
 * ONE strategy-relevant metric instead of the full chain (apply / APR /
 * interest saved / months / leftover) so the row reads in one glance.
 */
function CompactSinglePlanFooter({
  option,
  onPick,
}: {
  option: OptimizationOption;
  onPick: (text: string) => void;
}) {
  // Pick the headline metric most relevant to each strategy. The full
  // detail is still on the recommended row; this is just enough for the
  // user to decide whether to click in.
  let metric: string;
  if (option.strategy === "save_interest" && option.est_interest_saved_usd > 0) {
    metric = `Save ~${formatMoney(option.est_interest_saved_usd)} interest`;
  } else if (option.strategy === "free_cash_flow" && option.est_months_saved > 0) {
    metric = `~${option.est_months_saved} mo${option.est_months_saved === 1 ? "" : "s"} sooner`;
  } else if (option.closes_plan) {
    metric = `Closes for ${formatMoney(option.apply_amount_usd)}`;
  } else {
    metric = `Apply ${formatMoney(option.apply_amount_usd)}`;
  }

  return (
    <div className="mt-1.5 flex items-center justify-between gap-2">
      <span className="text-[11px] text-gray-500">{metric}</span>
      <button
        type="button"
        onClick={() =>
          onPick(
            option.closes_plan
              ? `Pay off my ${option.merchant} loan in full`
              : `Pay an extra ${formatMoney(option.apply_amount_usd)} toward my ${option.merchant} plan`
          )
        }
        className="text-[12px] font-semibold text-[#0A2540] px-3 py-1 rounded-full border border-gray-200 hover:border-[#0A2540]/40 hover:bg-gray-50 transition shrink-0"
      >
        {option.closes_plan ? `Pay off ${option.merchant}` : `Apply to ${option.merchant}`}
      </button>
    </div>
  );
}

function SinglePlanFooter({
  option,
  isTop,
  onPick,
}: {
  option: OptimizationOption;
  isTop: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-3 text-[11px] text-gray-500 mt-1.5 flex-wrap">
        <span>
          Apply{" "}
          <span className="font-semibold text-[#0A2540]">
            {formatMoney(option.apply_amount_usd)}
          </span>{" "}
          to {option.merchant}
        </span>
        <span className="text-gray-300">·</span>
        <span>{formatAprBps(option.apr_bps)}</span>
        {option.est_interest_saved_usd > 0 && (
          <>
            <span className="text-gray-300">·</span>
            <span>
              Save ~
              <span className="font-semibold text-emerald-700">
                {formatMoney(option.est_interest_saved_usd)}
              </span>{" "}
              interest
            </span>
          </>
        )}
        {option.est_months_saved > 0 && (
          <>
            <span className="text-gray-300">·</span>
            <span>
              ~{option.est_months_saved} mo{option.est_months_saved === 1 ? "" : "s"} sooner
            </span>
          </>
        )}
        {option.leftover_usd > 0.005 && (
          <>
            <span className="text-gray-300">·</span>
            <span>{formatMoney(option.leftover_usd)} left over</span>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() =>
          onPick(
            option.closes_plan
              ? `Pay off my ${option.merchant} loan in full`
              : `Pay an extra ${formatMoney(option.apply_amount_usd)} toward my ${option.merchant} plan`
          )
        }
        className="mt-2.5 text-[12px] font-semibold text-white px-3.5 py-1.5 rounded-full hover:opacity-90 transition"
        style={{ background: isTop ? ACCENT : "#0A2540" }}
      >
        {option.closes_plan
          ? `Pay off ${option.merchant}`
          : `Apply to ${option.merchant}`}
      </button>
    </>
  );
}

function AllocationBreakdown({
  legs,
  totalApplied,
  leftover,
  estInterestSaved,
  isTop,
  onPick,
}: {
  legs: AllocationLeg[];
  totalApplied: number;
  leftover: number;
  estInterestSaved: number;
  isTop: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50/60 overflow-hidden">
      <ul className="divide-y divide-gray-200">
        {legs.map((leg, i) => (
          <li
            key={`${leg.loan_id}-${i}`}
            className="px-3 py-2 flex items-center gap-2.5"
          >
            <MerchantLogo
              domain={leg.merchant_domain}
              name={leg.merchant}
              size={28}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[13px] font-semibold text-[#0A2540] truncate">
                  {leg.merchant}
                </span>
                {leg.closes_plan && (
                  <span className="text-[9px] uppercase tracking-wide font-bold px-1 py-px rounded bg-emerald-100 text-emerald-800">
                    Closes
                  </span>
                )}
                <AprChip bps={leg.apr_bps} size="xs" />
              </div>
              <div className="text-[11px] text-gray-500">
                {leg.closes_plan
                  ? `Pay full ${formatMoney(leg.apply_amount_usd)} balance`
                  : `Reduce by ${formatMoney(leg.apply_amount_usd)}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                onPick(
                  leg.closes_plan
                    ? `Pay off my ${leg.merchant} loan in full`
                    : `Pay an extra ${formatMoney(leg.apply_amount_usd)} toward my ${leg.merchant} plan`
                )
              }
              className="text-[11px] font-semibold text-white px-3 py-1 rounded-full shrink-0 hover:opacity-90 transition"
              style={{
                background: isTop && i === 0 ? ACCENT : "#0A2540",
              }}
            >
              {leg.closes_plan ? "Pay off" : "Apply"}
            </button>
          </li>
        ))}
      </ul>
      <div className="px-3 py-2 text-[11px] text-gray-500 flex items-center gap-3 flex-wrap bg-white">
        <span>
          Total applied{" "}
          <span className="font-semibold text-[#0A2540]">
            {formatMoney(totalApplied)}
          </span>
        </span>
        {estInterestSaved >= 1 && (
          <>
            <span className="text-gray-300">·</span>
            <span>
              Save ~
              <span className="font-semibold text-emerald-700">
                {formatMoney(estInterestSaved)}
              </span>{" "}
              interest
            </span>
          </>
        )}
        {leftover > 0.005 && (
          <>
            <span className="text-gray-300">·</span>
            <span>{formatMoney(leftover)} left over</span>
          </>
        )}
      </div>
      {/* Each leg authorizes independently — that's the whole point of
          surfacing them as separate buttons. The user reviews the strategy
          here, then taps each Pay/Apply to fire the existing single-plan
          WebAuthn assertion. No bulk-authorize path required, so the
          servicing executor surface stays unchanged. */}
      <div className="px-3 py-1.5 text-[10px] text-gray-400 leading-snug bg-white border-t border-gray-100">
        Each step authorizes with Face ID. Tap them in order.
      </div>
    </div>
  );
}

function strategyLabelFor(s: OptimizationStrategy): string {
  if (s === "save_interest") return "Save interest";
  if (s === "clear_plan") return "Close a plan";
  if (s === "allocate_across") return "Spread across plans";
  return "Free cash flow";
}

function strategyToneFor(s: OptimizationStrategy): { chip: string } {
  if (s === "save_interest") return { chip: "bg-violet-100 text-violet-800" };
  if (s === "clear_plan") return { chip: "bg-emerald-100 text-emerald-800" };
  if (s === "allocate_across") return { chip: "bg-indigo-100 text-indigo-800" };
  return { chip: "bg-blue-100 text-blue-800" };
}

type NextStepChip = {
  label: string;
  prompt: string;
  /**
   * Visual emphasis. The PRIMARY chip is the contextual recommendation
   * we'd actually take — it gets accent borders. SECONDARY is a generic
   * follow-up offered as an alternative. OFF_RAMP is the "I'm set" exit;
   * styled muted so the user always sees a clear way to end the loop.
   */
  variant: "primary" | "secondary" | "off_ramp";
};

/**
 * Format an APR in basis points for the chip label. Inline rather than
 * importing AprChip's helper because the chip body can't fit a styled
 * pill — we just need the text.
 */
function aprLabelForChip(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}% APR`;
}

/**
 * Compute the post-action "next step" chips. Deterministic — no LLM round
 * trip — because this is rendered immediately after a success card and
 * we don't want to add latency to a completed action. The 2 contextual
 * chips are derived from remaining-plan state (highest-APR plan still
 * standing, soonest upcoming payment) so they update as plans close.
 *
 * Why deterministic and not LLM-generated:
 *   - A completed action is the worst place to spend a 5-10s LLM round trip.
 *   - The system prompt forbids generic "anything else?" follow-ups; this
 *     surface is a contained alternative that hits only when we have
 *     specific cross-plan information worth surfacing.
 *   - Keeping it client-side means the suggestions reflect THIS session's
 *     post-action state, including any payoff that just completed.
 */
type ExecutedActionKind = "payoff" | "reschedule" | "pay_installment";

function nextStepChipsFor(
  actionKind: ExecutedActionKind,
  actedOnLoanId: string,
  paidOffLoanIds: Set<string>
): NextStepChip[] {
  // Remaining active plans = original demo plans minus anything that's been
  // paid off this session. The acted-on plan is included for reschedule and
  // pay-installment (the plan is still active), and excluded for payoff
  // (it's now in paidOffLoanIds).
  const remaining = DEMO_USER.activePlans.filter(
    (p: DemoActivePlan) => !paidOffLoanIds.has(p.id)
  );

  if (remaining.length === 0) {
    // User has closed every plan. Nothing else to suggest — only the exit.
    return [
      { label: "I'm set for now", prompt: "I'm set for now", variant: "off_ramp" },
    ];
  }

  // Highest-APR plan still active. Skip 0% promo plans — there's no
  // interest savings story there, so suggesting paydown would be weak.
  const interestBearing = [...remaining]
    .filter((p) => p.aprBps > 0)
    .sort((a, b) => b.aprBps - a.aprBps);
  const highApr = interestBearing[0];

  const chips: NextStepChip[] = [];

  if (actionKind === "payoff") {
    // After paying off a plan, the natural next move is the highest-rate
    // plan still standing. If there isn't one (only 0% plans left), fall
    // back to a generic forward-look on the remaining plans.
    if (highApr && highApr.id !== actedOnLoanId) {
      chips.push({
        label: `Look at ${highApr.merchant} — ${aprLabelForChip(highApr.aprBps)}`,
        prompt: `What about my ${highApr.merchant} plan?`,
        variant: "primary",
      });
    }
    chips.push({
      label: "What else is coming up?",
      prompt: "What's coming up across my other plans?",
      variant: "secondary",
    });
  } else if (actionKind === "reschedule") {
    // After moving a payment, the user's primary motivation was usually
    // cash flow — surface the cross-plan view as the lead suggestion.
    chips.push({
      label: "Check my other payments",
      prompt: "What else is coming up across my plans?",
      variant: "primary",
    });
    if (highApr && highApr.id !== actedOnLoanId) {
      chips.push({
        label: `Look at ${highApr.merchant} — ${aprLabelForChip(highApr.aprBps)}`,
        prompt: `What about my ${highApr.merchant} plan?`,
        variant: "secondary",
      });
    }
  } else {
    // pay_installment: similar shape to reschedule, lead with the
    // cross-plan view.
    chips.push({
      label: "What else is coming up?",
      prompt: "What's coming up across my other plans?",
      variant: "primary",
    });
    if (highApr && highApr.id !== actedOnLoanId) {
      chips.push({
        label: `Look at ${highApr.merchant} — ${aprLabelForChip(highApr.aprBps)}`,
        prompt: `What about my ${highApr.merchant} plan?`,
        variant: "secondary",
      });
    }
  }

  // Always include the off-ramp last so the user has a one-tap exit.
  // System prompt has a matching rule that turns "I'm set for now" into
  // a brief sign-off — no further suggestions, no "anything else?" loop.
  chips.push({
    label: "I'm set for now",
    prompt: "I'm set for now",
    variant: "off_ramp",
  });

  return chips;
}

function NextStepChips({
  chips,
  onPick,
}: {
  chips: NextStepChip[];
  onPick: (text: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-1">
      {chips.map((chip, i) => {
        const cls =
          chip.variant === "primary"
            ? "bg-white text-[#0A2540] border-[#6959F8]/40 hover:border-[#6959F8] hover:bg-[#F5F4FE] font-semibold"
            : chip.variant === "off_ramp"
            ? "bg-transparent text-gray-500 border-transparent hover:text-gray-700 hover:bg-gray-100"
            : "bg-white text-[#0A2540] border-gray-200 hover:border-gray-300";
        return (
          <button
            key={i}
            type="button"
            onClick={() => onPick(chip.prompt)}
            className={`text-[12px] px-3 py-1.5 rounded-full border transition ${cls}`}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

function AssistantBlockView({
  block,
  onPickPlan,
  onPickProduct,
  onRetry,
  executionState,
  onAuthorize,
  onViewInManage,
  isLatestSuccessfulAction,
  paidOffLoanIds,
}: {
  block: AssistantBlock;
  onPickPlan: (label: string, price?: number) => void;
  onPickProduct: (text: string) => void;
  onRetry: () => void;
  executionState: Record<string, BiometricExecutionState>;
  onAuthorize: (blockId: string, action: ServicingActionParams) => void;
  onViewInManage: () => void;
  /**
   * True only on the most-recent successful executed block in the
   * conversation. Drives whether to render the post-action "next step"
   * chips — older actions don't show suggestions because the user has
   * already moved past them.
   */
  isLatestSuccessfulAction: boolean;
  /** Loan IDs the user has paid off in this session (used to compute next-step suggestions). */
  paidOffLoanIds: Set<string>;
}) {
  if (block.kind === "text") {
    return (
      <div className="rounded-[20px] rounded-tl-[6px] px-4 py-3 whitespace-pre-wrap text-[15px] text-[#0A2540] bg-white shadow-sm border border-gray-100">
        {renderInlineMarkdown(block.content)}
      </div>
    );
  }
  if (block.kind === "error") return <ErrorBlock message={block.message} onRetry={onRetry} />;

  // Synthesized post-biometric success/error card (NOT produced by the LLM).
  if (block.kind === "executed") {
    const r = block.result;
    if ("error" in r) {
      return <ServicingErrorCard title="Servicing" message={r.message ?? String(r.error)} code={"code" in r ? r.code : undefined} />;
    }

    // Compute the next-step chips ONCE for this block. We pass paidOffLoanIds
    // as a snapshot; the chip helper figures out remaining-plan state and
    // formats the per-action suggestions deterministically.
    const chips = isLatestSuccessfulAction
      ? nextStepChipsFor(r.kind, r.loan_id, paidOffLoanIds)
      : [];
    const successCard =
      r.kind === "payoff" ? (
        <ServicingSuccessCard
          title="Payoff submitted"
          referenceId={r.reference_id}
          subtitle={`${r.merchant} · ${formatMoney(r.amount_usd)} · ${r.funding_source_label}`}
          email={r.email}
          policyCode={policyCodeToLabel(r.policy_codes?.[0]) || "Paid off"}
          onViewInManage={onViewInManage}
        />
      ) : r.kind === "reschedule" ? (
        <ServicingSuccessCard
          title="Due date updated"
          referenceId={r.reference_id}
          subtitle={`${r.merchant} · ${formatIsoDateShort(r.previous_due_iso)} → ${formatIsoDateShort(r.new_due_iso)}`}
          email={r.email}
          policyCode={policyCodeToLabel(r.policy_codes?.[0]) || "Rescheduled"}
          onViewInManage={onViewInManage}
        />
      ) : (
        <ServicingSuccessCard
          title="Payment submitted"
          referenceId={r.reference_id}
          subtitle={`${r.merchant} · ${formatMoney(r.amount_usd)} · ${r.funding_source_label}`}
          email={r.email}
          policyCode="Payment submitted"
          onViewInManage={onViewInManage}
        />
      );

    return (
      <div className="space-y-2">
        {successCard}
        {chips.length > 0 && <NextStepChips chips={chips} onPick={onPickProduct} />}
      </div>
    );
  }

  if (block.status === "complete" && block.result) {
    if (block.name === "calculate_affirm_terms") {
      const r = block.result as { plans?: Plan[]; price_usd?: number };
      if (r.plans) return <div className="space-y-2"><ToolBadge block={block} /><PlanSelector plans={r.plans} price={r.price_usd} onPick={(label) => onPickPlan(label, r.price_usd)} /></div>;
    }
    if (block.name === "check_affirm_capacity") {
      const r = block.result as CreditSummaryResult;
      if (r.active_plans) return <div className="space-y-2"><ToolBadge block={block} /><CreditSummary data={r} /></div>;
    }
    if (block.name === "search_products") {
      const r = block.result as SearchResult;
      if (r.results && r.results.length > 0) return <div className="space-y-2"><ToolBadge block={block} /><ProductGrid products={r.results} onPick={onPickProduct} /></div>;
    }
    if (block.name === "execute_purchase") {
      const r = block.result as PurchaseResult;
      if (r.status === "confirmed" && r.product && r.confirmation_code) return <div className="space-y-2"><ToolBadge block={block} /><PurchaseReceipt data={r} /></div>;
    }
    if (block.name === "servicing_payoff_quote") {
      const r = block.result as ServicingPayoffQuoteResult;
      if ("error" in r && r.error)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingErrorCard title="Payoff quote" message={r.message ?? String(r.error)} />
          </div>
        );
      if ("ok" in r && r.ok)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingPayoffQuoteCard
              data={r}
              blockId={block.id}
              state={executionState[block.id] ?? { phase: "idle" }}
              onConfirm={onAuthorize}
            />
          </div>
        );
    }
    if (block.name === "servicing_reschedule_preview") {
      const r = block.result as ServicingReschedulePreviewResult;
      if ("error" in r && r.error)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingErrorCard title="Reschedule" message={r.message ?? String(r.error)} />
          </div>
        );
      if ("ok" in r && r.ok)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingReschedulePreviewCard
              data={r}
              blockId={block.id}
              state={executionState[block.id] ?? { phase: "idle" }}
              onConfirm={onAuthorize}
            />
          </div>
        );
    }
    if (block.name === "servicing_refund_case") {
      const r = block.result as ServicingRefundCaseResult;
      if ("error" in r && r.error)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingErrorCard title="Refund" message={r.message ?? String(r.error)} />
          </div>
        );
      if ("ok" in r && r.ok)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingRefundCaseCard data={r} />
          </div>
        );
    }
    if (block.name === "servicing_triage_options") {
      const r = block.result as ServicingTriageResult;
      if ("error" in r && r.error)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingErrorCard title="Plan triage" message={r.message ?? String(r.error)} />
          </div>
        );
      if ("ok" in r && r.ok)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingTriageCard data={r} onPick={onPickProduct} />
          </div>
        );
    }
    if (block.name === "servicing_optimization_options") {
      const r = block.result as ServicingOptimizationResult;
      if ("error" in r && r.error)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingErrorCard title="Optimization" message={r.message ?? String(r.error)} />
          </div>
        );
      if ("ok" in r && r.ok)
        return (
          <div className="space-y-2">
            <ToolBadge block={block} />
            <ServicingOptimizationCard data={r} onPick={onPickProduct} />
          </div>
        );
    }
  }
  return <ToolBadge block={block} />;
}

function ToolBadge({ block }: { block: Extract<AssistantBlock, { kind: "tool" }> }) {
  const labels = TOOL_LABELS[block.name] ?? { running: block.name, done: block.name };
  const label = block.status === "running" ? labels.running : labels.done;
  return (
    <div className="inline-flex items-center gap-2 text-[12px] text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-3 py-1.5">
      {block.status === "running" ? (
        <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: ACCENT }} />
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      )}
      <span>{label}</span>
    </div>
  );
}

function ProductGrid({ products, onPick }: { products: Product[]; onPick: (label: string) => void }) {
  const shown = products.slice(0, 4);
  return (
    <div className="grid grid-cols-2 gap-2">
      {shown.map((p) => <ProductCard key={p.id} product={p} onPick={onPick} />)}
    </div>
  );
}

function ProductCard({ product, onPick }: { product: Product; onPick: (label: string) => void }) {
  const [imgErr, setImgErr] = useState(false);
  const price = `$${product.price.toLocaleString(undefined, { minimumFractionDigits: product.price % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
  const payIn4 = Math.round((product.price / 4) * 100) / 100;
  let hostname: string | null = null;
  try { if (product.url) hostname = new URL(product.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  const logoSrc = hostname ? `https://logo.clearbit.com/${hostname}` : null;
  const showPhoto = Boolean(product.image_url) && !imgErr;
  return (
    <button
      onClick={() => onPick(`I'll go with the ${product.title}`)}
      className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md hover:border-[#6959F8]/40 transition text-left flex flex-col"
    >
      <div className="aspect-square bg-gray-50 relative flex items-center justify-center overflow-hidden">
        {showPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.image_url} alt={product.title} className="w-full h-full object-cover" onError={() => setImgErr(true)} />
        ) : logoSrc ? (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 p-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoSrc} alt={product.merchant} className="max-w-full max-h-full object-contain opacity-80" />
          </div>
        ) : (
          <div className="text-gray-300 text-[10px] font-medium uppercase tracking-wide">{product.merchant}</div>
        )}
        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-white/95 backdrop-blur text-[10px] font-semibold text-[#0A2540] shadow-sm border border-gray-100">
          {product.merchant}
        </div>
      </div>
      <div className="px-3 py-2.5 flex-1 flex flex-col gap-1">
        <div className="text-[13px] font-semibold text-[#0A2540] line-clamp-2 leading-snug">{product.title}</div>
        <div className="mt-auto">
          <div className="text-[15px] font-semibold text-[#0A2540]">{price}</div>
          <div className="text-[11px] font-medium" style={{ color: ACCENT }}>or 4 × ${payIn4.toFixed(payIn4 % 1 === 0 ? 0 : 2)} with Affirm</div>
        </div>
      </div>
    </button>
  );
}

function CreditSummary({ data }: { data: CreditSummaryResult }) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-4 text-white" style={{ background: `linear-gradient(135deg, ${ACCENT} 0%, #4A3BB8 100%)` }}>
        <div className="text-[11px] uppercase tracking-wide opacity-80 font-medium">Available to spend</div>
        <div className="text-[32px] font-bold leading-tight mt-0.5">${data.available_credit_usd.toLocaleString()}</div>
        <div className="text-[12px] opacity-80 mt-1">Hi {data.user_first_name} — here&apos;s your Affirm snapshot</div>
      </div>
      <div className="px-4 pt-3 pb-1">
        <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Active plans ({data.active_plans.length})</div>
      </div>
      <div className="divide-y divide-gray-100">
        {data.active_plans.map((plan) => <ActivePlanRow key={plan.id} plan={plan} />)}
      </div>
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
        <div className="text-[12px] text-gray-500">Total monthly payment</div>
        <div className="text-[15px] font-semibold text-[#0A2540]">${data.total_monthly_obligation_usd}/mo</div>
      </div>
    </div>
  );
}

function ActivePlanRow({ plan }: { plan: ActivePlan }) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <MerchantAvatar name={plan.merchant} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px] font-semibold text-[#0A2540]">{plan.merchant}</span>
          {typeof plan.apr_bps === "number" && <AprChip bps={plan.apr_bps} size="xs" />}
        </div>
        <div className="text-[12px] text-gray-500 mt-0.5">${plan.balance_usd} remaining · {plan.months_remaining} months left</div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[14px] font-semibold text-[#0A2540]">${plan.monthly_payment_usd}/mo</div>
        {plan.next_payment_date && <div className="text-[11px] text-gray-500">Next: {plan.next_payment_date}</div>}
      </div>
    </div>
  );
}

function PlanSelector({ plans, price, onPick }: { plans: Plan[]; price?: number; onPick: (label: string) => void }) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Choose a plan</div>
        {typeof price === "number" && <div className="text-[14px] text-[#0A2540] font-semibold mt-0.5">${price.toLocaleString()} purchase</div>}
      </div>
      <div className="divide-y divide-gray-100">
        {plans.map((plan, i) => <PlanRow key={plan.id} plan={plan} highlighted={i === 0} onPick={() => onPick(plan.label)} />)}
      </div>
      <div className="px-4 py-2.5 bg-gray-50 text-[11px] text-gray-500 text-center">Rates from 0–36% APR. Terms shown are for this purchase.</div>
    </div>
  );
}

function PlanRow({ plan, highlighted, onPick }: { plan: Plan; highlighted: boolean; onPick: () => void }) {
  const sub = plan.cadence === "biweekly" ? `${plan.total_payments} payments, every 2 weeks` : `${plan.total_payments} monthly payments`;
  const aprLabel = plan.apr === 0 ? "0% APR" : `${plan.apr}% APR`;
  const amountLabel = `$${plan.monthly_payment_usd.toFixed(2)}`;
  const amountUnit = plan.cadence === "biweekly" ? "/ 2 wks" : "/ mo";
  return (
    <button onClick={onPick} className="w-full text-left px-4 py-3.5 flex items-center gap-3 hover:bg-gray-50 transition group">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[20px] font-bold text-[#0A2540]">{amountLabel}</span>
          <span className="text-[13px] text-gray-500">{amountUnit}</span>
          {highlighted && plan.apr === 0 && (
            <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: ACCENT }}>0% interest</span>
          )}
        </div>
        <div className="text-[12px] text-gray-500 mt-0.5">{sub} · {aprLabel} · ${plan.total_cost_usd.toFixed(2)} total</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300 group-hover:text-[#6959F8] transition flex-shrink-0">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  );
}

function PurchaseReceipt({ data }: { data: PurchaseResult }) {
  if (!data.product || !data.confirmation_code) return null;
  const p = data.product;
  const plan = data.plan;
  const cadenceLabel = plan?.cadence === "biweekly" ? "every 2 weeks" : "monthly";
  const aprLabel = plan ? (plan.apr === 0 ? "0% APR" : `${plan.apr}% APR`) : null;
  const monthly = plan ? `$${plan.monthly_payment_usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
  const emailLine = data.email?.status === "sent" ? `Receipt emailed to ${data.email.to}.` : data.email?.status === "skipped" ? "Receipt email skipped (no RESEND_API_KEY configured)." : data.email?.status === "failed" ? `Receipt email failed: ${data.email.error}` : null;
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-5 pt-5 pb-4 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg, #0f7a4e 0%, #16a870 100%)" }}>
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-full bg-white/25 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide opacity-90 font-medium">Order confirmed</div>
            <div className="text-[18px] font-bold leading-tight">You&apos;re all set</div>
          </div>
        </div>
      </div>
      <div className="px-5 py-4 space-y-3">
        <div className="flex items-start gap-3">
          {p.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.image_url} alt={p.title} className="w-14 h-14 rounded-lg object-cover border border-gray-100 flex-shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          ) : null}
          <div className="min-w-0">
            <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">{p.merchant}</div>
            <div className="text-[15px] font-semibold text-[#0A2540] mt-0.5 leading-snug">{p.title}</div>
          </div>
        </div>
        {plan ? (
          <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3 space-y-1">
            <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Your Affirm plan</div>
            <div className="text-[15px] font-semibold text-[#0A2540]">{plan.label} · {aprLabel}</div>
            <div className="text-[12px] text-gray-600 leading-relaxed">
              {plan.total_payments} payments of <span className="font-semibold text-[#0A2540]">{monthly}</span> {cadenceLabel}. First payment <span className="font-semibold text-[#0A2540]">{plan.first_payment_date}</span>.
            </div>
          </div>
        ) : null}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between text-[13px]"><span className="text-gray-500">Order total</span><span className="font-semibold text-[#0A2540]">${p.price_usd.toLocaleString()}</span></div>
          <div className="flex items-center justify-between text-[13px] pt-2 border-t border-gray-100"><span className="text-gray-500">Estimated delivery</span><span className="font-medium text-[#0A2540]">{data.estimated_delivery ?? "3–5 business days"}</span></div>
          <div className="flex items-center justify-between text-[13px] pt-2 border-t border-gray-100"><span className="text-gray-500">Confirmation</span><span className="font-mono font-medium text-[#0A2540]">{data.confirmation_code}</span></div>
          <div className="flex items-center justify-between text-[13px] pt-2 border-t border-gray-100">
            <span className="text-gray-500">Checkout via</span>
            {data.platform === "shopify" ? (
              <span className="flex items-center gap-1.5 font-medium text-[#0A2540]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M15.5 2.1c-.1 0-2.2-.2-2.2-.2l-1.5-1.5c-.1-.1-.3-.2-.5-.1L9.8.9C9.3.3 8.4 0 7.5 0 5.8 0 4.2 1.3 3.5 3.2c-.5.1-1 .3-1.5.4C.8 4 .7 4.1.6 5L0 19.1l11.9 2.3L18 20V2.6c-.1-.3-.4-.5-.5-.5zM11.3 3l-1.9.6c-.1-.6-.4-1.1-.7-1.5.7.3 1.4.8 1.9 1.5.2-.2.5-.4.7-.6zm-3.8-.9c.2 0 .4.1.6.2-.9.4-1.8 1.4-2.2 3.1l-1.6.5C4.9 4 6 2.1 7.5 2.1zm-.3 8.4c0 .1.1 1.7 1.6 1.7.7 0 1.3-.3 1.7-.8l-.3 4.3-3-.9.6-4.7c-.3.2-.6.4-.6.4zm0-2.7V6l1.1-.3c0 .6.1 1.4.1 2.1-.4.1-.8.5-.8 1-.2.2-.4.1-.4 0z" fill="#96BF48"/>
                  <path d="M15.5 2.1c-.1 0-2.2-.2-2.2-.2l-1.5-1.5c-.1-.1-.2-.1-.3-.1V21.4l6.1-1.4.9-17.4c-.3-.3-.7-.5-1-.5z" fill="#5E8E3E"/>
                </svg>
                Shopify
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-medium text-[#0A2540]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/>
                </svg>
                {p.merchant}&apos;s website
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 text-[12px] text-gray-600 leading-relaxed space-y-1">
        <div>{p.merchant} will email shipping details. Your Affirm plan is active — manage it anytime in the Affirm app.</div>
        {emailLine ? <div className="text-[11px] text-gray-500">{emailLine}</div> : null}
      </div>
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-[20px] rounded-tl-[6px] px-4 py-3 bg-red-50 border border-red-100 flex items-start gap-3">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
        <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] text-[#0A2540] leading-snug">{message}</div>
        <button onClick={onRetry} className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-[#dc2626] hover:text-[#b91c1c]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 11-3-6.7" /><path d="M21 4v5h-5" /></svg>
          Try again
        </button>
      </div>
    </div>
  );
}

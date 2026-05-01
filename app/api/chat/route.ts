import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFINITIONS, dispatchTool, type ToolContext } from "@/app/lib/tools";
import { buildSystemPrompt } from "@/app/lib/systemPrompt";
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

// System prompt lives in app/lib/systemPrompt.ts so the eval suite can import
// the EXACT same text the chat route uses (zero drift between demo and tests).
// If you need to tweak the prompt, edit it there, NOT in this route.

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

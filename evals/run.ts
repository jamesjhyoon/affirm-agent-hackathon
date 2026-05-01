/**
 * Eval suite runner.
 *
 * What this is: a regression harness for the Affirm Servicing Assistant.
 * For each prompt in evals/prompts.json, the runner sends ONE user message
 * to the production system prompt + tool definitions, captures the first
 * tool_use block in the LLM's response, and asserts on:
 *
 *   • which tool was called (or that NO tool was called for scope/injection)
 *   • whether specific input args (merchant_hint, amount_usd, requested_date_iso)
 *     match expectations
 *   • whether the assistant's prose contains forbidden text (e.g. system
 *     prompt leakage, hallucinated dates)
 *
 * Why it exists: the demo's central claim is "the agent routes intent
 * deterministically and stays in scope." A 30-prompt eval suite is the
 * minimum credible answer to "how did you measure that?" before a judge
 * asks. Running this in CI on every prompt change would be the production
 * extension.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npm run evals
 *
 * Optional:
 *   EVAL_FILTER=injection_   only run tests whose id starts with that prefix
 *   EVAL_PERSIST=1           write evals/results.json (default: write)
 *   EVAL_PERSIST=0           skip writing results
 *
 * Output:
 *   • Per-test pass/fail to stdout
 *   • Per-category breakdown
 *   • Overall pass rate
 *   • evals/results.json with the full result set (read by /about page)
 *
 * Cost: each test is one short LLM call (~ ${0.005}-${0.01}). 40 prompts ≈
 * $0.30 per run. Trivially cheap to gate on.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt } from "../app/lib/systemPrompt.ts";
import { TOOL_DEFINITIONS } from "../app/lib/toolSchemas.ts";

type Expectation = {
  tool_must_be?: string;
  tool_must_not_be_in?: string[];
  no_tool_call?: boolean;
  input_must_match?: Record<string, unknown>;
  input_must_have_key?: string;
  text_must_not_include_any?: string[];
  text_must_not_match_pattern?: string;
};

type Test = {
  id: string;
  category: string;
  user: string;
  expect: Expectation;
};

type PromptsFile = {
  categories: Record<string, string>;
  tests: Test[];
};

type TestResult = {
  id: string;
  category: string;
  user: string;
  passed: boolean;
  failures: string[];
  observed: {
    tool_name: string | null;
    tool_input: Record<string, unknown> | null;
    text: string;
  };
  elapsed_ms: number;
};

type RunSummary = {
  ranAt: string;
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
  results: TestResult[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadPrompts(): PromptsFile {
  const file = path.join(__dirname, "prompts.json");
  const raw = fs.readFileSync(file, "utf-8");
  return JSON.parse(raw) as PromptsFile;
}

async function runOneTest(
  client: Anthropic,
  test: Test,
  systemPrompt: string
): Promise<TestResult> {
  const t0 = Date.now();
  let toolName: string | null = null;
  let toolInput: Record<string, unknown> | null = null;
  let text = "";

  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages: [{ role: "user", content: test.user }],
    });

    for (const block of resp.content) {
      if (block.type === "tool_use" && toolName === null) {
        toolName = block.name;
        toolInput = block.input as Record<string, unknown>;
      } else if (block.type === "text") {
        text += block.text;
      }
    }
  } catch (err) {
    return {
      id: test.id,
      category: test.category,
      user: test.user,
      passed: false,
      failures: [`API error: ${(err as Error).message}`],
      observed: { tool_name: null, tool_input: null, text: "" },
      elapsed_ms: Date.now() - t0,
    };
  }

  const failures: string[] = [];
  const exp = test.expect;

  if (exp.tool_must_be && toolName !== exp.tool_must_be) {
    failures.push(
      `tool_must_be=${exp.tool_must_be} but got ${toolName ?? "<no tool>"}`
    );
  }
  if (exp.tool_must_not_be_in && toolName && exp.tool_must_not_be_in.includes(toolName)) {
    failures.push(
      `tool_must_not_be_in matched: called ${toolName}`
    );
  }
  if (exp.no_tool_call && toolName !== null) {
    failures.push(`no_tool_call expected but called ${toolName}`);
  }
  if (exp.input_must_match) {
    for (const [key, expectedVal] of Object.entries(exp.input_must_match)) {
      const actual = toolInput?.[key];
      if (typeof expectedVal === "string" && typeof actual === "string") {
        if (!actual.toLowerCase().includes(expectedVal.toLowerCase())) {
          failures.push(
            `input.${key} expected to contain "${expectedVal}", got "${actual}"`
          );
        }
      } else if (actual !== expectedVal) {
        failures.push(
          `input.${key} expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actual)}`
        );
      }
    }
  }
  if (exp.input_must_have_key) {
    if (!toolInput || !(exp.input_must_have_key in toolInput)) {
      failures.push(`input_must_have_key=${exp.input_must_have_key} missing`);
    }
  }
  if (exp.text_must_not_include_any) {
    for (const forbidden of exp.text_must_not_include_any) {
      if (text.toLowerCase().includes(forbidden.toLowerCase())) {
        failures.push(`text contains forbidden phrase: "${forbidden}"`);
      }
    }
  }
  if (exp.text_must_not_match_pattern) {
    const re = new RegExp(exp.text_must_not_match_pattern);
    if (re.test(text)) {
      failures.push(
        `text matched forbidden pattern: ${exp.text_must_not_match_pattern}`
      );
    }
  }

  return {
    id: test.id,
    category: test.category,
    user: test.user,
    passed: failures.length === 0,
    failures,
    observed: { tool_name: toolName, tool_input: toolInput, text },
    elapsed_ms: Date.now() - t0,
  };
}

function summarize(results: TestResult[]): RunSummary {
  const passed = results.filter((r) => r.passed).length;
  const byCatMap = new Map<string, { total: number; passed: number }>();
  for (const r of results) {
    const cur = byCatMap.get(r.category) ?? { total: 0, passed: 0 };
    cur.total += 1;
    if (r.passed) cur.passed += 1;
    byCatMap.set(r.category, cur);
  }
  const byCategory = [...byCatMap.entries()]
    .map(([category, v]) => ({
      category,
      total: v.total,
      passed: v.passed,
      passRate: v.total > 0 ? v.passed / v.total : 0,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    byCategory,
    results,
  };
}

function printSummary(summary: RunSummary, prompts: PromptsFile): void {
  console.log("");
  console.log("─".repeat(72));
  console.log(`Total:  ${summary.total}`);
  console.log(`Passed: ${summary.passed}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Rate:   ${(summary.passRate * 100).toFixed(1)}%`);
  console.log("");
  console.log("By category:");
  for (const c of summary.byCategory) {
    const desc = prompts.categories[c.category] ?? "";
    const bar = "█".repeat(Math.round(c.passRate * 20));
    const pad = "░".repeat(20 - Math.round(c.passRate * 20));
    console.log(
      `  ${c.category.padEnd(28)} ${c.passed}/${c.total}  ${bar}${pad}  ${(
        c.passRate * 100
      ).toFixed(0)}%`
    );
    if (desc) console.log(`    ${desc}`);
  }

  if (summary.failed > 0) {
    console.log("");
    console.log("Failures:");
    for (const r of summary.results) {
      if (r.passed) continue;
      console.log(`  • ${r.id} [${r.category}]`);
      console.log(`    user: ${r.user}`);
      for (const f of r.failures) console.log(`    × ${f}`);
    }
  }
  console.log("─".repeat(72));
}

async function main(): Promise<void> {
  const apiKey =
    process.env.LLM_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      "Missing API key. Set ANTHROPIC_API_KEY (or LLM_API_KEY) in your env."
    );
    process.exit(1);
  }

  const filter = process.env.EVAL_FILTER?.trim();
  const persist = process.env.EVAL_PERSIST !== "0";

  const prompts = loadPrompts();
  let tests = prompts.tests;
  if (filter) {
    tests = tests.filter((t) => t.id.startsWith(filter));
    console.log(`Filter: ${filter} (${tests.length} of ${prompts.tests.length} tests)`);
  }

  const client = new Anthropic({
    apiKey,
    baseURL: process.env.LLM_BASE_URL?.trim() || undefined,
  });

  // Same first-name the demo uses, so the prompt template renders identically.
  const systemPrompt = buildSystemPrompt("James");

  console.log(`Running ${tests.length} tests…\n`);

  const results: TestResult[] = [];
  // Sequential for predictable rate-limit behavior. Anthropic's tier 1
  // throughput would let us go parallel-of-3 here, but sequential is fine
  // for ~40 tests and avoids 429s eating the run.
  for (const test of tests) {
    const result = await runOneTest(client, test, systemPrompt);
    results.push(result);
    const tag = result.passed ? "PASS" : "FAIL";
    const dur = `${result.elapsed_ms}ms`.padStart(7);
    console.log(`  [${tag}] ${dur}  ${test.id.padEnd(34)} ${test.category}`);
    if (!result.passed) {
      for (const f of result.failures) console.log(`         × ${f}`);
    }
  }

  const summary = summarize(results);
  printSummary(summary, prompts);

  if (persist) {
    const out = path.join(__dirname, "results.json");
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(`\nResults written to ${out}`);
  }

  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval runner crashed:", err);
  process.exit(2);
});

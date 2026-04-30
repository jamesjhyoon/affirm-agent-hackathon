import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function probe({ label, domains, query }) {
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 3,
        allowed_callers: ["direct"],
        ...(domains ? { allowed_domains: domains } : {}),
      },
    ],
    messages: [
      {
        role: "user",
        content: `Search ${domains ? domains[0] : "the web"} for "${query}" and return the top 4 real product listings as a JSON array. Each item MUST have: title, price (number USD), url, description (1 sentence), merchant. Include image_url when you can. If first query is too narrow, refine. Output ONLY the JSON array.`,
      },
    ],
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`elapsed: ${elapsed}s  stop_reason: ${response.stop_reason}`);
  console.log(`content blocks: ${response.content.map((b) => b.type).join(", ")}`);

  for (const block of response.content) {
    if (block.type === "server_tool_use") {
      console.log(
        `[tool_use name=${block.name}]`,
        JSON.stringify(block.input).slice(0, 200)
      );
    } else if (block.type === "web_search_tool_result") {
      const inner = block.content;
      if (Array.isArray(inner)) {
        console.log(`[web_search_result] ${inner.length} items`);
        for (const r of inner.slice(0, 3)) {
          console.log(`  - ${r.title?.slice(0, 80)} :: ${r.url}`);
        }
      } else {
        console.log(`[web_search_result error]`, JSON.stringify(inner).slice(0, 300));
      }
    } else if (block.type === "text") {
      console.log(`[text] ${block.text.slice(0, 600)}`);
    }
  }
}

await probe({
  label: "Scoped: amazon.com",
  domains: ["amazon.com", "www.amazon.com"],
  query: "bicycles",
});

await probe({
  label: "Scoped: walmart.com (sanity check)",
  domains: ["walmart.com", "www.walmart.com"],
  query: "bicycles",
});

await probe({
  label: "Open web",
  domains: null,
  query: "bicycles",
});

import { searchProductsViaWeb, resolveMerchantHint } from "../app/lib/webSearch.ts";

async function run(label, query, hint) {
  const resolved = resolveMerchantHint(hint);
  console.log(`\n=== ${label} (domain=${resolved.domain ?? "open"}, name=${resolved.name}) ===`);
  const t0 = Date.now();
  const products = await searchProductsViaWeb(query, {
    merchantDomain: resolved.domain,
    merchantName: resolved.name,
    limit: 4,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`elapsed: ${elapsed}s  result_count: ${products.length}`);
  for (const p of products.slice(0, 3)) {
    console.log(`  - ${p.merchantName}: ${p.title.slice(0, 70)} — $${p.price}`);
  }
}

await run("amazon shoes", "running shoes", "amazon");
await run("amazon bicycles", "bicycles", "amazon.com");

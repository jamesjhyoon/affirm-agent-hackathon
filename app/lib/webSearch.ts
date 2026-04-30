import Anthropic from "@anthropic-ai/sdk";
import type { UnifiedProduct } from "./shopify";
import { MERCHANTS } from "./merchants";

const client = new Anthropic();

const productCache = new Map<string, UnifiedProduct>();

type QueryCacheEntry = { fetchedAt: number; products: UnifiedProduct[] };
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000;
const queryCache = new Map<string, QueryCacheEntry>();

export function getWebProductById(id: string): UnifiedProduct | null {
  return productCache.get(id) ?? null;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function prettyMerchant(domainOrName: string): string {
  const base = domainOrName.replace(/^www\./, "").split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function resolveMerchantHint(hint: string): {
  domain?: string;
  name: string;
} {
  const trimmed = hint.trim();
  if (!trimmed) return { name: "" };

  const lower = trimmed.toLowerCase();

  if (lower.includes(".")) {
    const domain = lower.replace(/^www\./, "");
    const directoryMatch = MERCHANTS.find((m) => m.domain === domain);
    return {
      domain,
      name: directoryMatch?.name ?? prettyMerchant(domain),
    };
  }

  const byId = MERCHANTS.find((m) => m.id.toLowerCase() === lower);
  if (byId) return { domain: byId.domain, name: byId.name };

  const byName = MERCHANTS.find(
    (m) => m.name.toLowerCase() === lower || m.name.toLowerCase().replace(/[^a-z0-9]/g, "") === lower.replace(/[^a-z0-9]/g, "")
  );
  if (byName) return { domain: byName.domain, name: byName.name };

  return { name: trimmed };
}

type RawProduct = {
  title?: unknown;
  price?: unknown;
  image_url?: unknown;
  url?: unknown;
  description?: unknown;
  merchant?: unknown;
};

function coerce(
  raw: RawProduct,
  defaultMerchant: string | undefined,
  expectedDomain: string | undefined,
  index: number
): UnifiedProduct | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const priceNum =
    typeof raw.price === "number"
      ? raw.price
      : typeof raw.price === "string"
      ? parseFloat(raw.price.replace(/[^0-9.]/g, ""))
      : NaN;
  const imageUrl = typeof raw.image_url === "string" ? raw.image_url : "";
  const url = typeof raw.url === "string" ? raw.url : "";
  const description =
    typeof raw.description === "string" ? raw.description.slice(0, 240) : "";
  const rawMerchant =
    typeof raw.merchant === "string" ? raw.merchant.trim() : "";

  if (!title || !Number.isFinite(priceNum) || priceNum <= 0) return null;

  const domain = domainFromUrl(url);

  if (expectedDomain) {
    const expected = expectedDomain.replace(/^www\./, "");
    const actual = domain.replace(/^www\./, "");
    if (!actual.endsWith(expected)) return null;
  }

  const merchantName = expectedDomain
    ? defaultMerchant || (domain ? prettyMerchant(domain) : "Store")
    : rawMerchant || defaultMerchant || (domain ? prettyMerchant(domain) : "Store");
  const merchantSlug = slug(merchantName) || "store";
  const id = `web::${merchantSlug}::${slug(title) || `item_${index}`}`;

  return {
    id,
    merchantId: merchantSlug,
    merchantName,
    title,
    price: Math.round(priceNum * 100) / 100,
    description,
    url,
    imageUrl: imageUrl || (domain ? `https://logo.clearbit.com/${domain}` : null),
    productType: "",
    tags: [],
  };
}

export async function searchProductsViaWeb(
  query: string,
  opts: {
    merchantDomain?: string;
    merchantName?: string;
    maxPrice?: number;
    limit?: number;
  } = {}
): Promise<UnifiedProduct[]> {
  const limit = opts.limit ?? 4;
  const priceClause = opts.maxPrice ? ` under $${opts.maxPrice}` : "";

  const cacheKey = `${query.trim().toLowerCase()}|${opts.merchantDomain ?? "*"}|${opts.maxPrice ?? ""}|${limit}`;
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < QUERY_CACHE_TTL_MS) {
    for (const p of cached.products) productCache.set(p.id, p);
    return cached.products;
  }

  const scopedName =
    opts.merchantName ??
    (opts.merchantDomain ? prettyMerchant(opts.merchantDomain) : undefined);

  const prompt = opts.merchantDomain
    ? `Search ${opts.merchantDomain} for "${query}"${priceClause}. Return the top ${limit} real listings as a JSON array.

Rules:
- Every url MUST be on ${opts.merchantDomain}.
- Each item: title, price (number USD), url, description (1 sentence), merchant ("${scopedName}"), image_url (direct product image).
- If no image found, omit image_url.
- Output ONLY the JSON array. No prose, no code fences.`
    : `Search the web for "${query}"${priceClause} at major retailers that accept Affirm (Amazon, Walmart, Target, Best Buy, Wayfair, Peloton, direct-to-consumer brands). Return top ${limit} real listings as a JSON array.

Each item: title, price (number USD), url (product page), description (1 sentence), merchant, image_url (optional). Output ONLY the JSON array.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1536,
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 1,
        allowed_callers: ["direct"],
        ...(opts.merchantDomain
          ? {
              allowed_domains: [
                opts.merchantDomain,
                `www.${opts.merchantDomain}`,
              ],
            }
          : {}),
      } as unknown as Anthropic.Tool,
    ],
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn(
      `[webSearch] no JSON array in response for "${query}" @ ${opts.merchantDomain ?? "open-web"}. Raw text (first 500 chars):`,
      text.slice(0, 500)
    );
    return [];
  }

  let raw: RawProduct[];
  try {
    raw = JSON.parse(jsonMatch[0]) as RawProduct[];
  } catch (parseErr) {
    console.warn(
      `[webSearch] JSON.parse failed for "${query}" @ ${opts.merchantDomain ?? "open-web"}:`,
      parseErr,
      "\nSnippet:",
      jsonMatch[0].slice(0, 300)
    );
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const products = raw
    .map((r, i) => coerce(r, scopedName, opts.merchantDomain, i))
    .filter((p): p is UnifiedProduct => p !== null)
    .slice(0, limit);

  if (products.length === 0) {
    console.warn(
      `[webSearch] parsed ${raw.length} raw items but 0 survived coercion for "${query}" @ ${opts.merchantDomain ?? "open-web"}. First raw item:`,
      JSON.stringify(raw[0] ?? null).slice(0, 300)
    );
  }

  for (const p of products) productCache.set(p.id, p);
  if (products.length > 0) {
    queryCache.set(cacheKey, { fetchedAt: Date.now(), products });
  }

  return products;
}

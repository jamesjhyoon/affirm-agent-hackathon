import { SHOPPABLE_MERCHANTS, type Merchant } from "./merchants";

export type UnifiedProduct = {
  id: string;
  merchantId: string;
  merchantName: string;
  title: string;
  price: number;
  description: string;
  url: string;
  imageUrl: string | null;
  productType: string;
  tags: string[];
};

type ShopifyVariant = {
  price: string;
  available: boolean;
};

type ShopifyImage = {
  src: string;
};

type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: ShopifyVariant[];
  images: ShopifyImage[];
};

type CacheEntry = { fetchedAt: number; products: UnifiedProduct[] };
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function stripHtml(s: string) {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(
  merchant: Merchant,
  product: ShopifyProduct
): UnifiedProduct | null {
  const firstAvailable =
    product.variants.find((v) => v.available) ?? product.variants[0];
  if (!firstAvailable) return null;
  const price = parseFloat(firstAvailable.price);
  if (Number.isNaN(price) || price <= 0) return null;

  return {
    id: `${merchant.id}::${product.id}`,
    merchantId: merchant.id,
    merchantName: merchant.name,
    title: product.title,
    price,
    description: stripHtml(product.body_html || "").slice(0, 240),
    url: `https://${merchant.shopifyDomain}/products/${product.handle}`,
    imageUrl: product.images?.[0]?.src ?? null,
    productType: product.product_type || "",
    tags: Array.isArray(product.tags) ? product.tags : [],
  };
}

async function fetchMerchantProducts(
  merchant: Merchant
): Promise<UnifiedProduct[]> {
  if (!merchant.shopifyDomain) return [];

  const cached = cache.get(merchant.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.products;
  }

  try {
    const res = await fetch(
      `https://${merchant.shopifyDomain}/products.json?limit=250`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (AffirmAssistantPrototype)" },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) {
      console.warn(`[shopify] ${merchant.id} returned ${res.status}`);
      return cached?.products ?? [];
    }
    const data = (await res.json()) as { products: ShopifyProduct[] };
    const products = data.products
      .map((p) => normalize(merchant, p))
      .filter((p): p is UnifiedProduct => p !== null);
    cache.set(merchant.id, { fetchedAt: Date.now(), products });
    return products;
  } catch (err) {
    console.warn(`[shopify] ${merchant.id} fetch failed:`, err);
    return cached?.products ?? [];
  }
}

const STOP_WORDS = new Set([
  "a", "an", "the", "for", "of", "and", "or", "to", "in", "on", "with",
  "me", "i", "my", "get", "buy", "find", "need", "want", "some",
  "please", "under", "below", "over", "around", "about", "new",
]);

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function scoreProduct(
  product: UnifiedProduct,
  tokens: string[],
  strict: boolean
): number {
  if (tokens.length === 0) return 0;
  const title = product.title.toLowerCase();
  const type = product.productType.toLowerCase();
  const merchant = product.merchantName.toLowerCase();
  const tagBlob = product.tags.join(" ").toLowerCase();
  const desc = product.description.toLowerCase();
  const haystack = `${title} ${type} ${merchant} ${tagBlob} ${desc}`;

  const matchedTokens = tokens.filter((t) => haystack.includes(t));
  if (strict && matchedTokens.length < tokens.length) return 0;
  if (matchedTokens.length === 0) return 0;

  let score = 0;
  for (const t of matchedTokens) {
    if (title.includes(t)) score += 6;
    if (type.includes(t)) score += 4;
    if (merchant.includes(t)) score += 2;
    if (tagBlob.includes(t)) score += 1;
    if (desc.includes(t)) score += 1;
  }
  score += matchedTokens.length * 3;
  return score;
}

// Try fetching products from any domain that might be running Shopify.
// Fails silently — caller falls back to web search if this returns [].
export async function searchShopifyByDomain(
  domain: string,
  merchantName: string,
  query: string,
  opts: { maxPrice?: number; limit?: number } = {}
): Promise<UnifiedProduct[]> {
  const cacheKey = `__dynamic__${domain}`;
  const cached = cache.get(cacheKey);
  let products: UnifiedProduct[];

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    products = cached.products;
  } else {
    try {
      const res = await fetch(
        `https://${domain}/products.json?limit=250`,
        {
          headers: { "User-Agent": "Mozilla/5.0 (AffirmAssistantPrototype)" },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { products?: ShopifyProduct[] };
      if (!Array.isArray(data.products)) return [];
      const syntheticMerchant: Merchant = {
        id: cacheKey,
        name: merchantName,
        category: "Other",
        domain,
        logoUrl: `https://logo.clearbit.com/${domain}`,
        description: "",
        shoppable: true,
        shopifyDomain: domain,
      };
      products = data.products
        .map((p) => normalize(syntheticMerchant, p))
        .filter((p): p is UnifiedProduct => p !== null);
      cache.set(cacheKey, { fetchedAt: Date.now(), products });
    } catch {
      return [];
    }
  }

  const tokens = tokenize(query);
  let scored = products
    .map((p) => ({ product: p, score: scoreProduct(p, tokens, true) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    scored = products
      .map((p) => ({ product: p, score: scoreProduct(p, tokens, false) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
  }

  let results = scored.map(({ product }) => product);
  if (typeof opts.maxPrice === "number") {
    results = results.filter((p) => p.price <= opts.maxPrice!);
  }
  return results.slice(0, opts.limit ?? 6);
}

export function getProductById(id: string): UnifiedProduct | null {
  const [merchantId] = id.split("::");
  if (!merchantId) return null;
  const cached = cache.get(merchantId);
  if (!cached) return null;
  return cached.products.find((p) => p.id === id) ?? null;
}

export async function searchShopifyProducts(
  query: string,
  opts: { maxPrice?: number; limit?: number; merchantIds?: string[] } = {}
): Promise<UnifiedProduct[]> {
  const merchants = opts.merchantIds
    ? SHOPPABLE_MERCHANTS.filter((m) => opts.merchantIds!.includes(m.id))
    : SHOPPABLE_MERCHANTS;

  const allProducts = (
    await Promise.all(merchants.map((m) => fetchMerchantProducts(m)))
  ).flat();

  const tokens = tokenize(query);

  // Try strict (all tokens must match), fall back to non-strict (any token matches)
  let scored = allProducts
    .map((p) => ({ product: p, score: scoreProduct(p, tokens, true) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    scored = allProducts
      .map((p) => ({ product: p, score: scoreProduct(p, tokens, false) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
  }

  let results = scored.map(({ product }) => product);
  if (typeof opts.maxPrice === "number") {
    results = results.filter((p) => p.price <= opts.maxPrice!);
  }

  const seen = new Set<string>();
  const deduped: UnifiedProduct[] = [];
  for (const p of results) {
    const key = `${p.merchantId}::${p.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  return deduped.slice(0, opts.limit ?? 6);
}

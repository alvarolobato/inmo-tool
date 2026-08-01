/**
 * OpenRouter catalog fetcher + in-process cache.
 *
 * Lives in a sibling module (not in `route.ts`) because Next.js App
 * Router rejects any non-handler exports from a route file. The route
 * imports `getCachedCatalog()` and `resetCatalogCache()` from here.
 *
 * Each catalog row is either:
 *  - **Auto** — OpenRouter's default multi-provider routing for the model.
 *  - **Pinned** — a specific upstream endpoint (see `provider_label`), with
 *    per-endpoint pricing from OpenRouter's `/models/.../endpoints` API.
 */

import { encodeOpenRouterModelValue } from "@/lib/llm-provider/openrouter-selection";

export interface OpenRouterRawPricing {
  prompt?: string | null;
  completion?: string | null;
  request?: string | null;
  image?: string | null;
  input_cache_read?: string | null;
  input_cache_write?: string | null;
}

export interface OpenRouterRawArchitecture {
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  tokenizer?: string;
}

export interface OpenRouterRawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: OpenRouterRawPricing;
  architecture?: OpenRouterRawArchitecture;
  supported_parameters?: string[];
  links?: { details?: string };
}

interface OpenRouterRawCatalog {
  data: OpenRouterRawModel[];
}

/** One row in the admin model combobox (auto-routed or pinned provider). */
export interface OpenRouterModel {
  /** Same as `config_value` — unique key for React. */
  row_key: string;
  /** Persisted to `dashboard.llm_model_openrouter*` keys. */
  config_value: string;
  /** The `model` field on OpenRouter chat completions. */
  model_id: string;
  /** Human-friendly provider / routing label for search + display. */
  provider_label: string;
  /** True = OpenRouter default routing; false = pinned `provider` object. */
  is_auto_row: boolean;
  name: string;
  description: string;
  context_length: number;
  /** USD per 1M prompt tokens. `null` if pricing is missing. */
  prompt_price_per_1m: number | null;
  /** USD per 1M completion tokens. `null` if pricing is missing. */
  completion_price_per_1m: number | null;
  modality: string;
  /** True iff the row supports tools (required for agentic flows). */
  supports_tools: boolean;
  /** Curated auto row pinned in "Populares" (popular model ids only). */
  popular: boolean;
}

export interface CatalogPayload {
  models: OpenRouterModel[];
  fetchedAt: number;
  source: "openrouter" | "cache";
}

// ---------------------------------------------------------------------------
// Curated popular set (auto rows only)
// ---------------------------------------------------------------------------

export const POPULAR_IDS: readonly string[] = [
  "anthropic/claude-opus-4",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-haiku-4",
  "anthropic/claude-3.5-sonnet",
  "openai/gpt-5",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/o3-mini",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-r1",
  "deepseek/deepseek-v3",
  "meta-llama/llama-4-maverick",
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-large",
  "x-ai/grok-4",
];

const POPULAR_SET: ReadonlySet<string> = new Set(POPULAR_IDS);

// ---------------------------------------------------------------------------
// Cache (in-process, 1 h TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000;

const ENDPOINT_FETCH_CONCURRENCY = 12;

interface CacheEntry {
  models: OpenRouterModel[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

/** Test-only hook to clear the cache between assertions. */
export function resetCatalogCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function priceFromPerToken(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n * 1_000_000;
}

function trimDescription(raw: string | undefined): string {
  const description = (raw ?? "").trim();
  return description.length > 220 ? description.slice(0, 217) + "…" : description;
}

interface RawEndpoint {
  provider_name?: string;
  tag?: string;
  context_length?: number;
  pricing?: OpenRouterRawPricing;
  supported_parameters?: string[];
}

function providerRoutingForTag(tag: string): Record<string, unknown> {
  const slug = tag.trim().toLowerCase();
  return { only: [slug], allow_fallbacks: false };
}

function endpointLabel(ep: RawEndpoint): string {
  const name = (ep.provider_name ?? "").trim();
  const tag = (ep.tag ?? "").trim();
  if (name && tag) return `${name} · ${tag}`;
  if (name) return name;
  if (tag) return tag;
  return "Endpoint";
}

async function fetchEndpointsForModel(detailsPath: string): Promise<RawEndpoint[]> {
  const url = `https://openrouter.ai${detailsPath}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const json: unknown = await res.json();
  const data = json as { data?: { endpoints?: RawEndpoint[] } };
  const eps = data?.data?.endpoints;
  return Array.isArray(eps) ? eps : [];
}

function buildAutoRow(raw: OpenRouterRawModel): OpenRouterModel {
  const supportsTools = (raw.supported_parameters ?? []).includes("tools");
  const description = trimDescription(raw.description);
  const modelId = raw.id;
  const configValue = encodeOpenRouterModelValue(modelId, undefined);
  return {
    row_key: configValue,
    config_value: configValue,
    model_id: modelId,
    provider_label: "OpenRouter (automático)",
    is_auto_row: true,
    name: raw.name ?? raw.id,
    description,
    context_length: typeof raw.context_length === "number" ? raw.context_length : 0,
    prompt_price_per_1m: priceFromPerToken(raw.pricing?.prompt),
    completion_price_per_1m: priceFromPerToken(raw.pricing?.completion),
    modality: raw.architecture?.modality ?? "text->text",
    supports_tools: supportsTools,
    popular: POPULAR_SET.has(modelId),
  };
}

function buildPinnedRow(base: OpenRouterRawModel, ep: RawEndpoint): OpenRouterModel {
  const supportsTools = (ep.supported_parameters ?? base.supported_parameters ?? []).includes("tools");
  const description = trimDescription(base.description);
  const modelId = base.id;
  const tag = (ep.tag ?? "").trim();
  const routing = tag ? providerRoutingForTag(tag) : null;
  const configValue = encodeOpenRouterModelValue(modelId, routing ?? undefined);
  return {
    row_key: configValue,
    config_value: configValue,
    model_id: modelId,
    provider_label: endpointLabel(ep),
    is_auto_row: false,
    name: base.name ?? base.id,
    description,
    context_length:
      typeof ep.context_length === "number" && ep.context_length > 0
        ? ep.context_length
        : typeof base.context_length === "number"
          ? base.context_length
          : 0,
    prompt_price_per_1m: priceFromPerToken(ep.pricing?.prompt ?? base.pricing?.prompt),
    completion_price_per_1m: priceFromPerToken(ep.pricing?.completion ?? base.pricing?.completion),
    modality: base.architecture?.modality ?? "text->text",
    supports_tools: supportsTools,
    popular: false,
  };
}

/**
 * Test helper — normalise a raw `/models` entry into a single **auto** row
 * (no endpoint expansion). Matches historical `normalize()` behaviour.
 */
export function normalize(raw: OpenRouterRawModel): OpenRouterModel {
  return buildAutoRow(raw);
}

async function fetchAndExpandCatalog(): Promise<OpenRouterModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models returned ${res.status}`);
  }
  const json = (await res.json()) as OpenRouterRawCatalog;
  if (!Array.isArray(json.data)) {
    throw new Error("OpenRouter /models returned unexpected shape (no data array)");
  }

  const rawModels = json.data;
  const rows: OpenRouterModel[] = [];

  for (let i = 0; i < rawModels.length; i += ENDPOINT_FETCH_CONCURRENCY) {
    const slice = rawModels.slice(i, i + ENDPOINT_FETCH_CONCURRENCY);
    const endpointLists = await Promise.all(
      slice.map(async (raw) => {
        const path = raw.links?.details;
        if (!path || typeof path !== "string") return [] as RawEndpoint[];
        return fetchEndpointsForModel(path);
      }),
    );

    for (let j = 0; j < slice.length; j++) {
      const raw = slice[j];
      rows.push(buildAutoRow(raw));
      const eps = endpointLists[j];
      for (const ep of eps) {
        const tag = (ep.tag ?? "").trim();
        if (!tag) continue;
        rows.push(buildPinnedRow(raw, ep));
      }
    }
  }

  return rows;
}

/**
 * Returns the catalog, hitting the cache when fresh and falling back to
 * a stale cache if the upstream request fails. Throws only when no cache
 * exists at all *and* the fetch fails.
 */
export async function getCachedCatalog(): Promise<CatalogPayload> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { models: cache.models, fetchedAt: cache.fetchedAt, source: "cache" };
  }
  try {
    const models = await fetchAndExpandCatalog();
    cache = { models, fetchedAt: now };
    return { models, fetchedAt: now, source: "openrouter" };
  } catch (err) {
    if (cache) {
      return { models: cache.models, fetchedAt: cache.fetchedAt, source: "cache" };
    }
    throw err;
  }
}

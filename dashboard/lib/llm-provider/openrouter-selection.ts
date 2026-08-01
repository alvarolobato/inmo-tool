/**
 * Encode / decode optional OpenRouter `provider` routing alongside the model id
 * in a single config string (e.g. `dashboard.llm_model_openrouter`).
 *
 * Format:
 *   - Auto routing (OpenRouter default): `vendor/model`
 *   - Pinned provider / endpoint: `vendor/model\t{...JSON...}` (tab separator)
 *
 * The JSON body is passed (after sanitisation) as the `provider` field on
 * `chat.completions` requests — see OpenRouter provider routing docs.
 */

const ROUTING_SEP = "\t";

/** Keys OpenRouter documents for the `provider` object on chat completions. */
const ALLOWED_PROVIDER_KEYS = new Set([
  "order",
  "only",
  "ignore",
  "allow_fallbacks",
  "require_parameters",
  "data_collection",
  "zdr",
  "enforce_distillable_text",
  "quantizations",
  "sort",
  "max_price",
  "preferred_min_throughput",
  "preferred_max_latency",
]);

export interface ParsedOpenRouterModelValue {
  /** Model id sent as the `model` parameter (no routing suffix). */
  modelId: string;
  /** When set, forwarded as `provider` on OpenRouter chat completions. */
  provider?: Record<string, unknown>;
}

function sanitizeProviderObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_PROVIDER_KEYS.has(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a stored dashboard OpenRouter model value into API model id + optional
 * `provider` preferences.
 */
export function parseOpenRouterModelValue(stored: string): ParsedOpenRouterModelValue {
  const s = (stored ?? "").trim();
  if (!s) return { modelId: "" };

  const tab = s.indexOf(ROUTING_SEP);
  if (tab === -1) {
    return { modelId: s };
  }

  const modelId = s.slice(0, tab).trim();
  const jsonPart = s.slice(tab + ROUTING_SEP.length).trim();
  if (!jsonPart) {
    return { modelId: modelId || s };
  }

  try {
    const parsed: unknown = JSON.parse(jsonPart);
    const provider = sanitizeProviderObject(parsed);
    return { modelId: modelId || s, provider };
  } catch {
    // Malformed suffix — treat whole string as model id for resilience.
    return { modelId: s.split(ROUTING_SEP)[0].trim() || s };
  }
}

/**
 * Build the value persisted in config from a model id and optional OpenRouter
 * `provider` object.
 */
export function encodeOpenRouterModelValue(
  modelId: string,
  provider: Record<string, unknown> | null | undefined,
): string {
  const id = (modelId ?? "").trim();
  if (!id) return "";
  const p = sanitizeProviderObject(provider);
  if (!p) return id;
  return `${id}${ROUTING_SEP}${JSON.stringify(p)}`;
}

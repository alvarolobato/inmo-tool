/**
 * #28 — unstructured-to-structured extraction, per deduplicated property.
 *
 * Many private-seller listings never publish `m2_built`/`rooms`/`bathrooms`/
 * `floor`/`has_elevator` as structured site fields — only inside the free-text
 * description. Task 2.4's hard filters run against the structured `property`
 * columns, so those listings currently fail (or get excluded from) filters
 * requiring a field the portal simply didn't structure, not because the flat
 * doesn't actually match. This flow recovers what the text already says so
 * that gap doesn't unfairly penalise exactly the private-seller listings that
 * are often the most interesting (less competition, more negotiation room) —
 * issue #28's own framing, and issue #5's context.
 *
 * ## Property-level, not listing-level (a deliberate deviation from issue #28's wording)
 *
 * Issue #28 itself, and `lib/llm.ts`'s original module doc (written when #24
 * shipped this flow's plumbing ahead of the real prompt), describe this as a
 * per-listing extraction: "recovers *per-advert* structured fields." That
 * turned out not to fit the schema — every field this flow can fill
 * (`m2_built`, `m2_useful`, `rooms`, `bathrooms`, `floor`, `has_elevator`) is a
 * column on `property`, not `listing` (`etl/schema/init.sql`). The dedup
 * pipeline already reconciles per-listing facts onto that one property row, so
 * "does this listing already have the field" is the wrong question — "does
 * the PROPERTY already have the field" is. Following #25/#26/#27's established
 * shape (read every live listing of the property together, so a disclosure in
 * one portal's text is not missed because a sibling advert's shorter or vaguer
 * text is what got read) is both more correct AND reuses the exact plumbing
 * (`loadPropertyListings`, `ai_assessment` keyed on `property_id`, the #30
 * cache wrapper) the other three flows already have, instead of inventing a
 * parallel listing-keyed storage path for this one flow alone.
 *
 * ## Cost control (issue #28 EC-3, technical approach #2)
 *
 * There is no point spending an LLM call extracting `m2_built` from a
 * property that already has it structured. `needsExtraction()` below is the
 * pure gating check: true iff at least one of the six fields this flow can
 * fill is still NULL on `property`. `assessPropertyExtract` runs that check
 * BEFORE loading listings or touching the LLM — see its doc.
 *
 * ## Strict output validation (issue #28 technical approach #3)
 *
 * "Numbers must be parsed as actual numeric types... not left as strings
 * embedded in prose" — downstream filtering does numeric comparisons against
 * these values, so a wrong type is worse than a missing value. `parseExtractResult`
 * THROWS (rather than silently coercing or nulling) when a numeric field is
 * present but not actually a finite number, or when `has_elevator` is present
 * but not actually a boolean — the same "reject on malformed output, let the
 * caller retry" discipline `parseRedFlagsResult` already applies to a
 * non-array `flags`. `floor` is the one exception: a model writing the number
 * `3` instead of the string `"3"` is coerced, not rejected, because the
 * concern the issue raises is specifically about fields downstream code
 * numerically COMPARES against (`rooms`, `bathrooms`, `m2_built`, `m2_useful`)
 * — `floor` is inherently free text ("bajo", "ático", "3ºB") and nothing
 * compares it numerically.
 *
 * Server-only: imports lib/db-write (the `pg` client) via shared.ts. Never
 * import from a client component.
 */

import { sql } from "@/lib/db-write";
import { extractStructuredFields } from "@/lib/llm";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import { NoListingsError, loadPropertyListings, clamp01, stripCodeFence, num } from "./shared";
import { getOrCompute, getLatestAssessment, type CachedAssessment } from "./cache";

export { NoListingsError, loadPropertyListings };

/**
 * Prompt version. Bump when the extract prompt or output schema changes in a
 * way that could change what gets extracted, so `ai_assessment`'s unique key
 * treats the new output as a distinct row rather than colliding with the old
 * prompt's (same convention as the other three flows).
 */
export const EXTRACT_PROMPT_VERSION = "extract/v1";

/** The six fields this flow can fill — exactly the `property` columns issue #28 names. */
export const EXTRACT_FIELDS = [
  "m2_built",
  "m2_useful",
  "rooms",
  "bathrooms",
  "floor",
  "has_elevator",
] as const;

export type ExtractField = (typeof EXTRACT_FIELDS)[number];

export interface ExtractResult {
  m2_built: number | null;
  m2_useful: number | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  has_elevator: boolean | null;
  /**
   * Per-field confidence (issue #28 technical approach #1) — a consumer can
   * trust a high-confidence `rooms` extraction while discounting a shakier
   * `floor` guess from the SAME response, which a single scalar confidence
   * could never express. Only fields the model actually filled (non-null)
   * may have an entry — see `parseConfidencePerField`.
   */
  confidence_per_field: Partial<Record<ExtractField, number>>;
  reasoning: string;
}

/** The subset of `property` columns this flow either reads (gating) or fills. */
export interface PropertyStructuredFields {
  m2_built: number | null;
  m2_useful: number | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  has_elevator: boolean | null;
}

interface RawPropertyStructuredRow {
  m2_built: string | null;
  m2_useful: string | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  has_elevator: boolean | null;
}

/**
 * Load the property's current structured fields (for the cost-control gating
 * check). Returns `null` when the property row itself doesn't exist.
 *
 * A dedicated query rather than reusing `loadPropertyListings`'s property
 * SELECT: that query is shaped for the LLM payload (includes address/city/
 * province, omits `m2_useful`/`has_elevator`) and is joined to the listings
 * fetch — this one needs to run BEFORE deciding whether listings are even
 * worth loading (see `assessPropertyExtract`).
 */
export async function loadPropertyStructuredFields(
  propertyId: number,
): Promise<PropertyStructuredFields | null> {
  const rows = await sql<RawPropertyStructuredRow>(
    `SELECT m2_built, m2_useful, rooms, bathrooms, floor, has_elevator
       FROM property WHERE id = $1`,
    [propertyId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    m2_built: num(r.m2_built),
    m2_useful: num(r.m2_useful),
    rooms: r.rooms,
    bathrooms: r.bathrooms,
    floor: r.floor,
    has_elevator: r.has_elevator,
  };
}

/**
 * EC-3 (issue #28): true iff at least one of the six fields this flow can
 * fill is still NULL on the property — i.e. there is something worth an LLM
 * call to recover. Pure function, no DB access, so it's directly testable
 * without mocking `sql`.
 */
export function needsExtraction(fields: PropertyStructuredFields): boolean {
  return EXTRACT_FIELDS.some((f) => fields[f] === null);
}

function parseNumberField(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `Extract flow returned a non-numeric '${key}': ${JSON.stringify(v)}`,
    );
  }
  return v;
}

/**
 * `floor` is inherently free text. A model that writes the JSON number `3`
 * instead of the string `"3"` is coerced, not rejected — see module doc for
 * why this one field gets leniency the numeric-comparison fields don't.
 */
function parseFloorField(o: Record<string, unknown>): string | null {
  const v = o.floor;
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new Error(`Extract flow returned a malformed 'floor': ${JSON.stringify(v)}`);
}

function parseBooleanField(o: Record<string, unknown>): boolean | null {
  const v = o.has_elevator;
  if (v === null || v === undefined) return null;
  if (typeof v !== "boolean") {
    throw new Error(
      `Extract flow returned a non-boolean 'has_elevator': ${JSON.stringify(v)}`,
    );
  }
  return v;
}

/**
 * Defensive, not strict: an out-of-range or malformed confidence is metadata,
 * not a value downstream code numerically compares listings against, so a bad
 * entry is dropped rather than failing the whole parse (unlike the six data
 * fields above, per module doc's numeric-comparison distinction).
 */
function parseConfidencePerField(
  o: Record<string, unknown>,
): Partial<Record<ExtractField, number>> {
  const raw = o.confidence_per_field;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Partial<Record<ExtractField, number>> = {};
  for (const key of EXTRACT_FIELDS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp01(v);
  }
  return out;
}

/** Parse and strictly validate the model's JSON into the extract result. */
export function parseExtractResult(raw: string): ExtractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Extract flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Extract flow returned a non-object JSON value.");
  }
  const o = parsed as Record<string, unknown>;

  return {
    m2_built: parseNumberField(o, "m2_built"),
    m2_useful: parseNumberField(o, "m2_useful"),
    rooms: parseNumberField(o, "rooms"),
    bathrooms: parseNumberField(o, "bathrooms"),
    floor: parseFloorField(o),
    has_elevator: parseBooleanField(o),
    confidence_per_field: parseConfidencePerField(o),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * `ai_assessment.confidence` for an extraction row: the mean of whatever
 * per-field confidences the model actually reported (no "flagged" concept
 * here, unlike occupancy's `summaryConfidence` — every field is equally
 * "the thing we were looking for", there's no clean/caveat distinction to
 * pick the max of). Zero fields extracted → confidence 0 (nothing to be
 * confident about), never NaN.
 */
export function summaryConfidence(result: ExtractResult): number {
  const values = Object.values(result.confidence_per_field).filter(
    (v): v is number => typeof v === "number",
  );
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Persist a verdict, replacing any prior one for the same prompt version.
 * `contentHash` (#30) defaults to NULL for direct callers that don't compute
 * one — see occupancy.ts's `saveOccupancyAssessment` doc for the same note.
 */
export async function saveExtractAssessment(
  propertyId: number,
  result: ExtractResult,
  model: string | null,
  contentHash: string | null = null,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, content_hash, generated_at)
     VALUES ($1, 'extract', $2::jsonb, $3, $4, $5, $6, NOW())
     ON CONFLICT ON CONSTRAINT ai_assessment_property_key
     DO UPDATE SET result = EXCLUDED.result,
                   confidence = EXCLUDED.confidence,
                   model = EXCLUDED.model,
                   content_hash = EXCLUDED.content_hash,
                   generated_at = EXCLUDED.generated_at`,
    [
      propertyId,
      JSON.stringify(result),
      summaryConfidence(result),
      model,
      EXTRACT_PROMPT_VERSION,
      contentHash,
    ],
  );
}

/**
 * Read the cached extraction for a property, if one exists. Latest row
 * regardless of prompt_version, with `stale` — see occupancy.ts's
 * `getOccupancyAssessment` doc for the full rationale (#30).
 */
export async function getExtractAssessment(
  propertyId: number,
): Promise<CachedAssessment<ExtractResult> | null> {
  return getLatestAssessment<ExtractResult>(
    propertyId,
    "extract",
    EXTRACT_PROMPT_VERSION,
  );
}

/** Discriminated outcome of `assessPropertyExtract` — see its doc. */
export type ExtractOutcome =
  | { skipped: true; reason: string }
  | { skipped: false; result: ExtractResult };

/**
 * Assess one property end-to-end: skip if there's nothing left to fill in
 * (EC-3), else load its merged listings, ask the model (unless an unchanged
 * extraction is already cached — #30), validate, persist.
 *
 * Gating runs BEFORE loading listings, deliberately: if the property already
 * has every field this flow can fill, there is no reason to even build the
 * listings payload, let alone spend an LLM call on it.
 *
 * Throws `NoListingsError` when the property doesn't exist, has no live
 * listings, or every live listing has no description (see
 * `loadPropertyListings`) — same 404 signal the other three flows use.
 */
export async function assessPropertyExtract(
  propertyId: number,
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<ExtractOutcome> {
  const fields = await loadPropertyStructuredFields(propertyId);
  if (!fields) throw new NoListingsError(propertyId);

  if (!needsExtraction(fields)) {
    return {
      skipped: true,
      reason:
        "La propiedad ya tiene todos los campos estructurados que este flujo puede rellenar.",
    };
  }

  const listings = await loadPropertyListings(propertyId);
  if (listings.length === 0) throw new NoListingsError(propertyId);

  const { result } = await getOrCompute<ExtractResult>(
    propertyId,
    "extract",
    EXTRACT_PROMPT_VERSION,
    listings,
    async () => {
      const { text, model } = await extractStructuredFields(listings, opts);
      return { result: parseExtractResult(text), model };
    },
    saveExtractAssessment,
  );
  return { skipped: false, result };
}

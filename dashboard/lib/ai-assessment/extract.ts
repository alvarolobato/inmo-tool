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
 * ## Not yet consumed anywhere (fast-follow, issue #182)
 *
 * This flow ONLY writes `ai_assessment.result` — nothing currently reads it.
 * `lib/filtering/scope-query.ts`'s hard filters (task 2.4, #18, merged before
 * this task landed) query `property.m2_built`/`property.has_elevator`/
 * `property.floor` directly, with no fallback to an `extract` row when the
 * structured column is NULL; `lib/candidates.ts`'s `loadFlags` (the query the
 * candidate-card badges read) filters `assessment_type IN ('occupancy',
 * 'condition')`, which doesn't include `'extract'` either. Per #28's own
 * "Additional Context" ("flag it as a fast-follow issue if task 2.4 has
 * already merged by the time this task lands" — it had), issue #182 tracks
 * wiring `scope-query.ts` to `COALESCE(property.<col>, <ai_assessment
 * fallback>)`. Provenance is preserved either way: this flow never writes
 * back to `property`/`listing` (see "NOT directly overwriting" above), so a
 * future consumer reads the connector-parsed value and the LLM-inferred one
 * from two different places and can tell them apart, rather than this flow
 * quietly overwriting one with the other.
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
 * pure gating check: true iff at least one of `GATING_FIELDS` is still NULL
 * on `property`. `assessPropertyExtract` runs that check BEFORE loading
 * listings or touching the LLM — see its doc.
 *
 * `GATING_FIELDS` is `EXTRACT_FIELDS` MINUS `m2_useful` (#30 review finding —
 * previously the gate was dead code). Every connector hardcodes
 * `m2_useful=None` (fotocasa.py:842, idealista.py:269, milanuncios.py:436,
 * solvia.py:402, vivantial.py:297, servihabitat.py:429) and this flow never
 * writes its own output back onto `property` (see "NOT directly overwriting"
 * above) — so no code path anywhere can ever make `property.m2_useful`
 * non-NULL. Leaving it in the gating set made `needsExtraction()` return
 * `true` unconditionally, for every property, forever, which made the
 * `{skipped:true}` branch in `assessPropertyExtract`/the POST route
 * unreachable in production. `m2_useful` stays in `EXTRACT_FIELDS` (the
 * output schema, and `confidence_per_field`'s vocabulary) — only the gate
 * excludes it.
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
import { getOrCompute, getLatestAssessment, logCacheOutcome, type CachedAssessment } from "./cache";

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
   * could never express. Enforced both ways by `parseConfidencePerField`
   * (#30 review — previously documented but not checked): a field left
   * `null` may NEVER have an entry here, and a field the model filled MUST
   * have one — there is no third state where "no entry" quietly means
   * "confidence zero" for a field that was actually extracted.
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
 * The fields the cost-control gate actually checks — see module doc's "Cost
 * control" section for why this excludes `m2_useful`.
 */
export const GATING_FIELDS = EXTRACT_FIELDS.filter(
  (f): f is Exclude<ExtractField, "m2_useful"> => f !== "m2_useful",
);

/**
 * EC-3 (issue #28): true iff at least one of `GATING_FIELDS` is still NULL on
 * the property — i.e. there is something worth an LLM call to recover. Pure
 * function, no DB access, so it's directly testable without mocking `sql`.
 */
export function needsExtraction(fields: PropertyStructuredFields): boolean {
  return GATING_FIELDS.some((f) => fields[f] === null);
}

/**
 * Plausibility bounds per numeric field (#30 review: "no plausibility
 * bounds — m2_built:-40, rooms:0, bathrooms:999 all parse cleanly"). The
 * module's own argument for strict type validation is that a wrong value is
 * worse than a missing one *because downstream does numeric comparisons*
 * (task 2.4's hard filters, scope-query.ts) — a negative m² or a 999-bathroom
 * flat breaks that exactly as badly as a string does, so it gets the same
 * reject-don't-coerce treatment as a non-numeric value, not a silent pass.
 * `integer: true` additionally rejects a fractional room/bathroom count,
 * which is never a real answer to "número de habitaciones".
 */
const NUMERIC_FIELD_BOUNDS: Record<
  "m2_built" | "m2_useful" | "rooms" | "bathrooms",
  { min: number; max: number; integer?: boolean }
> = {
  m2_built: { min: 1, max: 100000 },
  m2_useful: { min: 1, max: 100000 },
  rooms: { min: 1, max: 50, integer: true },
  bathrooms: { min: 0, max: 20, integer: true },
};

function parseNumberField(
  o: Record<string, unknown>,
  key: keyof typeof NUMERIC_FIELD_BOUNDS,
): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `Extract flow returned a non-numeric '${key}': ${JSON.stringify(v)}`,
    );
  }
  const bounds = NUMERIC_FIELD_BOUNDS[key];
  if (bounds.integer && !Number.isInteger(v)) {
    throw new Error(
      `Extract flow returned a non-integer '${key}': ${JSON.stringify(v)}`,
    );
  }
  if (v < bounds.min || v > bounds.max) {
    throw new Error(
      `Extract flow returned an implausible '${key}': ${JSON.stringify(v)} ` +
        `(expected ${bounds.min}-${bounds.max})`,
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
 * Enforces both directions of the invariant this module's own doc states but
 * previously didn't check (#30 review finding):
 *
 *   1. Only a field the model actually FILLED (non-null in `fieldValues`) may
 *      carry a `confidence_per_field` entry. A confidence for a field left
 *      `null` is dropped — silently, the same "metadata, not a compared
 *      value" treatment an out-of-range confidence already got — rather than
 *      counted. Before this fix, `{m2_built:null, rooms:null,
 *      confidence_per_field:{rooms:0.9, m2_built:0.8}}` produced
 *      `summaryConfidence` 0.85 despite zero fields actually being extracted,
 *      directly contradicting this file's own "zero fields extracted →
 *      confidence 0" doc.
 *   2. Every field the model DID fill must carry one. Per the extract prompt
 *      itself ("Por cada campo que rellenes con un valor... añade su
 *      confianza en confidence_per_field"), a filled field with no reported
 *      confidence is malformed output, not a value to silently average as if
 *      "no entry" and "confidence 0" were the same thing — so this throws,
 *      matching the strict, reject-don't-guess treatment the six data fields
 *      already get above, rather than leaving the ambiguity in place.
 *
 * Still defensive about the VALUE once a field is confirmed eligible: an
 * out-of-range confidence is clamped (`clamp01`), not rejected — the
 * confidence number itself is metadata, only its presence/absence for the
 * right field is enforced strictly.
 */
function parseConfidencePerField(
  o: Record<string, unknown>,
  fieldValues: Record<ExtractField, unknown>,
): Partial<Record<ExtractField, number>> {
  const raw = o.confidence_per_field;
  const rawObj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const out: Partial<Record<ExtractField, number>> = {};
  for (const key of EXTRACT_FIELDS) {
    const filled = fieldValues[key] !== null;
    if (!filled) continue; // invariant 1: no entry for a null field, ever.

    const v = rawObj[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(
        `Extract flow filled '${key}' but provided no confidence_per_field entry for it.`,
      );
    }
    out[key] = clamp01(v);
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

  const m2_built = parseNumberField(o, "m2_built");
  const m2_useful = parseNumberField(o, "m2_useful");
  const rooms = parseNumberField(o, "rooms");
  const bathrooms = parseNumberField(o, "bathrooms");
  const floor = parseFloorField(o);
  const has_elevator = parseBooleanField(o);

  // Confidence validation runs AFTER all six fields are parsed: it needs to
  // know which fields actually ended up non-null (see parseConfidencePerField
  // doc) — the parse order above must not change without keeping this last.
  const confidence_per_field = parseConfidencePerField(o, {
    m2_built,
    m2_useful,
    rooms,
    bathrooms,
    floor,
    has_elevator,
  });

  return {
    m2_built,
    m2_useful,
    rooms,
    bathrooms,
    floor,
    has_elevator,
    confidence_per_field,
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * `ai_assessment.confidence` for an extraction row: the mean of whatever
 * per-field confidences the model actually reported (no "flagged" concept
 * here, unlike occupancy's `summaryConfidence` — every field is equally
 * "the thing we were looking for", there's no clean/caveat distinction to
 * pick the max of). Zero fields extracted → confidence 0 (nothing to be
 * confident about), never NaN — and, since `parseConfidencePerField` now
 * enforces that every non-null field has an entry and every null field
 * doesn't, "0 fields extracted" and "confidence_per_field is empty" are
 * exactly the same condition (they used to be able to disagree — see that
 * function's doc).
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

  const { result, fromCache } = await getOrCompute<ExtractResult>(
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
  logCacheOutcome("extract", propertyId, fromCache);
  return { skipped: false, result };
}

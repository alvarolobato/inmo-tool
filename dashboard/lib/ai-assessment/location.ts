/**
 * #388 (Fase 3 de #385) — `location` assessment axis, per deduplicated property.
 *
 * Answers the owner's headline ask: "primera línea de playa / vistas al mar" —
 * a signal NO portal exposes as a filter, so it has to be derived from the
 * free-text description. It also carries a `heritage_zone` boolean (casco/centro
 * histórico — prestige of location AND a possible reform-licence complication).
 *
 * ## LLM-only detection, NEVER runtime regex (owner decision, 2026-08-06)
 *
 * The owner explicitly does NOT trust keyword/regex matching for this signal.
 * The product path that assigns a `beach_proximity` value to a property is this
 * LLM assessment — a prompt (`buildLocationPrompt` in
 * `lib/llm-context/system-prompt.ts`) that reads the advert text and classifies
 * with a literal cited quote at `temperature: 0`, mirroring `condition.ts`
 * exactly. There is NO ILIKE/regex classifier anywhere in this file or its
 * prompt. (Mining prevalence with SQL/ILIKE in dev was fine — that only sized
 * the signal; it is not how a property gets a verdict.) See
 * `docs/decisions/D-095-location-axis.md`.
 *
 * Text-only for now: there is no coastline/geo dataset in the DB (a geo
 * corroboration layer is a future enhancement, not a blocker — #385).
 *
 * ## Two sub-signals on one axis
 *
 *  - **`beach_proximity`** — a GRADED enum, not a boolean, because "primera
 *    línea" and "vistas al mar" are genuinely different facts an investor
 *    weighs differently: `frontline` (a pie de playa / acceso directo) >
 *    `sea_view` (vistas al mar sin ser primera línea) > `near_beach`
 *    (cerca/andando, paseo marítimo) > `none` (sin señal).
 *  - **`heritage_zone`** — a boolean + evidence (casco/centro histórico).
 *
 * Each sub-signal requires its own literal `evidence` quote or degrades to the
 * safe default (`none` / `false`) — the same anti-false-positive backstop
 * `redflags.parseFlag` and `condition`'s `unclear`-on-no-evidence rule enforce
 * in code rather than trusting to the model.
 *
 * Server-only: imports lib/db-write (the `pg` client) via shared.ts. Never
 * import from a client component.
 */

import { sql } from "@/lib/db-write";
import { assessLocation } from "@/lib/llm";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import {
  NoListingsError,
  loadPropertyListings,
  parseVerdict,
  clamp01,
  stripCodeFence,
} from "./shared";
import { getOrCompute, getLatestAssessment, logCacheOutcome, type CachedAssessment } from "./cache";

export { NoListingsError, loadPropertyListings };

/**
 * Prompt version. Bump when the location prompt changes in a way that could
 * change a verdict, so `ai_assessment`'s unique key treats the new output as a
 * distinct row and #308's batch scheduler re-assesses (same convention as
 * `CONDITION_PROMPT_VERSION`). `v1` is the initial axis (#388).
 */
export const LOCATION_PROMPT_VERSION = "location/v1";

// The beach-proximity vocabulary + badge labels live in the leaf module
// `location-vocabulary.ts` (no `pg`/LLM imports) so the redflags prompt builder
// can render them without the system-prompt → location → llm → llm-context cycle
// (#407). Re-exported here so existing importers (`lib/candidates.ts`) keep using
// `@/lib/ai-assessment/location` unchanged.
export {
  BEACH_PROXIMITIES,
  BEACH_PROXIMITY_LABELS,
  HERITAGE_ZONE_LABEL,
  type BeachProximity,
} from "./location-vocabulary";
import { BEACH_PROXIMITIES, type BeachProximity } from "./location-vocabulary";

/**
 * Single-property location result. Flattened (not a nested `verdict` object)
 * with a graded `beach_proximity` enum plus a sibling `heritage_zone` boolean,
 * each carrying its OWN literal evidence quote + source so the investor can go
 * and check either claim independently.
 */
export interface LocationResult {
  /** frontline | sea_view | near_beach | none (graded). */
  beach_proximity: BeachProximity;
  /** Literal quote backing `beach_proximity`, or "" when nothing could be cited. */
  beach_evidence: string;
  /** Portal that quote came from, or null. */
  beach_evidence_source: string | null;
  /** True only when the text places the property in a casco/centro histórico. */
  heritage_zone: boolean;
  /** Literal quote backing `heritage_zone`, or "" when nothing could be cited. */
  heritage_evidence: string;
  /** Portal that quote came from, or null. */
  heritage_evidence_source: string | null;
  /** Confidence in the (graded) beach reading. */
  confidence: number;
  reasoning: string;
}

/**
 * Whether the `location` axis applies to a property of this type (#388, owner
 * decision). A `terreno` (bare plot) has no "primera línea / vistas al mar /
 * casco histórico" reading in the same product sense, so it is excluded from
 * this axis entirely — `assessPropertyLocation` skips it before any LLM call.
 * A null/unknown type is NOT excluded: better to assess than to silently drop a
 * mis-typed flat.
 */
export function locationApplies(propertyType: string | null | undefined): boolean {
  return (propertyType ?? "").trim().toLowerCase() !== "terreno";
}

/**
 * Parse and validate the model's JSON into the location result.
 *
 * Reuses `parseVerdict` for the graded beach axis (unknown value → `none` at
 * zero confidence), then applies the same evidence-or-fallback backstop
 * `condition.ts` uses: a non-`none` beach verdict with no literal citation is
 * degraded to `none`/0, and a `heritage_zone: true` with no citation is
 * degraded to `false`. This is the code-side "si no puedes citar nada, no
 * afirmes nada" guard, not something trusted to the prompt.
 */
export function parseLocationResult(raw: string): LocationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Location flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Location flow returned a non-object JSON value.");
  }

  const o = parsed as Record<string, unknown>;

  // Beach axis via the shared verdict parser. `parseVerdict` reads `evidence`/
  // `evidence_source`/`confidence`, so hand it a node whose keys map from this
  // flow's beach_* fields — one axis's evidence must not leak into the other's.
  const rawBeach = parseVerdict(
    {
      beach_proximity: o.beach_proximity,
      confidence: o.confidence,
      evidence: o.beach_evidence,
      evidence_source: o.beach_evidence_source,
    },
    "beach_proximity",
    BEACH_PROXIMITIES,
    "none",
  );

  // Evidence-or-fallback backstop: a graded verdict with no citation is not
  // "we looked and it's beachfront" — it's exactly what the assessment rules
  // forbid. Degrade to `none` at zero confidence (mirrors condition.ts).
  const beach =
    rawBeach.value !== "none" && rawBeach.evidence.trim() === ""
      ? { ...rawBeach, value: "none" as const, confidence: 0 }
      : rawBeach;

  // Heritage boolean + its own evidence guard (mirrors redflags' drop-uncited).
  const heritageClaimed = o.heritage_zone === true;
  const heritageEvidence =
    typeof o.heritage_evidence === "string" ? o.heritage_evidence : "";
  const heritageEvidenceSource =
    typeof o.heritage_evidence_source === "string" && o.heritage_evidence_source.trim() !== ""
      ? o.heritage_evidence_source
      : null;
  const heritage = heritageClaimed && heritageEvidence.trim() !== "";

  return {
    beach_proximity: beach.value,
    beach_evidence: beach.evidence,
    beach_evidence_source: beach.evidence_source,
    heritage_zone: heritage,
    heritage_evidence: heritage ? heritageEvidence : "",
    heritage_evidence_source: heritage ? heritageEvidenceSource : null,
    confidence: clamp01(beach.confidence),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * Persist a verdict, replacing any prior one for the same prompt version.
 * `contentHash` defaults to NULL for direct callers — see condition.ts.
 */
export async function saveLocationAssessment(
  propertyId: number,
  result: LocationResult,
  model: string | null,
  contentHash: string | null = null,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, content_hash, generated_at)
     VALUES ($1, 'location', $2::jsonb, $3, $4, $5, $6, NOW())
     ON CONFLICT ON CONSTRAINT ai_assessment_property_key
     DO UPDATE SET result = EXCLUDED.result,
                   confidence = EXCLUDED.confidence,
                   model = EXCLUDED.model,
                   content_hash = EXCLUDED.content_hash,
                   generated_at = EXCLUDED.generated_at`,
    [
      propertyId,
      JSON.stringify(result),
      result.confidence,
      model,
      LOCATION_PROMPT_VERSION,
      contentHash,
    ],
  );
}

/** Read the cached verdict for a property, if one exists. */
export async function getLocationAssessment(
  propertyId: number,
): Promise<CachedAssessment<LocationResult> | null> {
  return getLatestAssessment<LocationResult>(propertyId, "location", LOCATION_PROMPT_VERSION);
}

/** Discriminated outcome of `assessPropertyLocation` — see its doc. */
export type LocationOutcome =
  | { skipped: true; reason: string }
  | { skipped: false; result: LocationResult };

/**
 * Assess one property end-to-end: load its merged listings, skip a `terreno`
 * plot (owner decision — the axis doesn't apply), else ask the model (unless an
 * unchanged verdict is already cached — #30), validate, persist.
 *
 * Throws `NoListingsError` when the property has no live listings, OR when every
 * live listing has no description (see `loadPropertyListings`) — same 404 signal
 * the other flows use.
 */
export async function assessPropertyLocation(
  propertyId: number,
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<LocationOutcome> {
  const listings = await loadPropertyListings(propertyId);
  if (listings.length === 0) throw new NoListingsError(propertyId);

  // Terreno exclusion (#388, owner decision) — a plot has no beach/heritage
  // reading in the same sense; skip before any LLM spend. property_type is a
  // property-level fact, identical across a deduplicated property's listings.
  if (!locationApplies(listings[0].propertyType)) {
    return {
      skipped: true,
      reason: "El eje 'location' no aplica a un terreno/solar.",
    };
  }

  const { result, fromCache } = await getOrCompute<LocationResult>(
    propertyId,
    "location",
    LOCATION_PROMPT_VERSION,
    listings,
    async () => {
      const { text, model } = await assessLocation(listings, opts);
      return { result: parseLocationResult(text), model };
    },
    saveLocationAssessment,
  );
  logCacheOutcome("location", propertyId, fromCache);
  return { skipped: false, result };
}

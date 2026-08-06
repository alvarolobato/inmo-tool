/**
 * #27 / #361 — generic property-problem extraction, per deduplicated property.
 *
 * Extracts mentions an investor should check before making an offer. Two
 * families of problem live on this one axis:
 *
 *   - **Legal / financial** (the original #27 scope): embargoes, unsettled
 *     inheritance, community debts, illegal construction, pending litigation —
 *     things to check with a lawyer.
 *   - **Physical** (broadened in #361): condition problems that fall through
 *     every other axis — first and foremost `unfinished_construction` (obra
 *     inacabada / parcialmente ejecutada / obra parada — property 796:
 *     "inmueble en construcción… parcialmente ejecutada, con algunos tabiques
 *     ya levantados"), plus clearly-stated structural damage. This is NOT
 *     occupancy, NOT `a_reformar` (a finished flat needing a refurb), and NOT
 *     `obra_nueva` (a completed new build) — a half-built shell is its own
 *     category, which is why #361 broadened this axis rather than adding a
 *     fifth.
 *
 * NOT a substitute for real legal or technical due diligence — output is
 * framed as "worth checking", never as a verdict (issue #27, scope note).
 * `other` remains the catch-all for the long tail of problems that fit no
 * named category. Every flag, legal or physical, still carries a
 * human-readable `description` and a required literal `evidence` citation.
 *
 * Follows #25's established property-level shape (see
 * `lib/ai-assessment/occupancy.ts` for the full rationale, and
 * `lib/ai-assessment/shared.ts` for the plumbing reused here): one physical
 * property has one set of legal facts, and a disclosure that appears in only
 * one portal's text must not be missed because a sibling advert stayed
 * silent on it.
 *
 * ## False positives are the expensive failure mode here (issue #27, EC-3)
 *
 * Unlike occupancy/condition, this flow has no "axis" with a default reading
 * — there is no market convention under which silence implies a red flag, so
 * `parseVerdict`'s silence-default mechanism does not apply. The defence
 * against manufactured flags is enforced in `parseRedFlagsResult` itself,
 * not just in the prompt:
 *
 *   - a flag with no `evidence` citation is dropped, full stop — this
 *     mirrors ASSESSMENT_RULES' "si no puedes citar nada, no afirmes nada",
 *     enforced in code rather than trusted to the model;
 *   - a `type` outside the closed vocabulary is coerced to `other` rather
 *     than dropped (the model found *something* worth a lawyer's look, it
 *     just used a different label for it — dropping would silently lose a
 *     real disclosure, whereas rendering it as `other` keeps the vocabulary
 *     closed for whatever eventually renders it — see the "never render an
 *     unmapped model string raw" rule `lib/candidates.ts` follows for
 *     occupancy's caveats).
 *
 * ## Deliberate overlap with #25's `ownership` axis (`proindiviso`)
 *
 * KEPT, not deduplicated — see the #27 issue thread for the full argument.
 * Short version: #25's `ownership` axis answers "what is actually being
 * sold" (a `proindiviso` share is a fact about the transaction — can you
 * finance it, occupy it, force a sale). This flow's `herencia_yacente` type
 * answers "what should a lawyer check before you commit" (an unresolved
 * inheritance may mean the seller cannot deliver clean title). Same
 * underlying fact, two different questions a buyer needs answered
 * separately; collapsing them would force a choice between describing the
 * asset and flagging the legal risk.
 *
 * Server-only: imports lib/db-write (the `pg` client) via shared.ts. Never
 * import from a client component.
 */

import { sql } from "@/lib/db-write";
import { extractRedFlags } from "@/lib/llm";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import { NoListingsError, loadPropertyListings, clamp01, stripCodeFence } from "./shared";
import { getOrCompute, getLatestAssessment, logCacheOutcome, type CachedAssessment } from "./cache";
import { buildAreaPriceSignal } from "./price-signal";

export { NoListingsError, loadPropertyListings };

/**
 * Prompt version. Bump when the redflags prompt changes in a way that could
 * change what gets flagged, so `ai_assessment`'s unique key treats the new
 * output as a distinct row rather than colliding with the old prompt's.
 *
 * Bumped to v2 for #184: the stable prompt text gained the "Contexto de
 * precio de zona" rules block (system-prompt.ts's `AREA_PRICE_SIGNAL_RULES`)
 * and the volatile payload can now carry a derived price-comparison line —
 * both change what the model reads, so a v1 cache row must not silently pass
 * as current.
 *
 * Bumped to v3 for #361: the axis was broadened from legal/financial only to
 * generic property problems — the prompt now also reads the advert for
 * PHYSICAL problems (`unfinished_construction`, `structural_damage`), so its
 * output changed (a half-built property that used to yield `flags: []` now
 * yields an `unfinished_construction` flag). #308's batch re-assesses existing
 * rows against the new version.
 *
 * Bumped to v4 for #389 (Fase 2 of #385): `subasta_judicial` (judicial
 * auction / procedimiento de apremio) was split out of `embargo` into its own
 * closed-vocabulary type, so a listing that used to yield an `embargo` flag
 * (or none, when the model hesitated to call an auction an embargo) now yields
 * a `subasta_judicial` flag — the prompt reads and labels it differently.
 * #308's batch re-assesses existing rows against the new version.
 */
export const REDFLAGS_PROMPT_VERSION = "redflags/v4";

/**
 * Closed type vocabulary (issue #27 technical approach #1, broadened in #361).
 * The first block is legal/financial (#27); the second is physical problems
 * (#361). `other` is the catch-all for a real disclosure that doesn't fit the
 * named categories — used both by the model directly and as the coercion
 * target for an unrecognised label (see module doc).
 */
export const REDFLAG_TYPES = [
  // Legal / financial (#27)
  "embargo",
  "subasta_judicial",
  "herencia_yacente",
  "deuda_comunidad",
  "construccion_ilegal",
  "litigio",
  // Physical (#361)
  "unfinished_construction",
  "structural_damage",
  "other",
] as const;

export type RedFlagType = (typeof REDFLAG_TYPES)[number];

/**
 * Short Spanish badge label per problem type, for the card and the property
 * detail page (#361). The vocabulary lives here, so its display labels do too
 * — both `lib/candidates.ts` (`flagsFromAssessments`) and the detail page's
 * `PropertyProblemFlags` read this one map instead of duplicating it.
 *
 * `other` is deliberately absent: it's the long-tail catch-all with no
 * stable, scannable meaning, so a generic "Problema" badge would carry no
 * information (the same reason `reformado`/`unclear` get no condition badge).
 * A flag whose `type` isn't a key here is dropped by the renderers, never
 * shown as raw text.
 */
export const REDFLAG_LABELS: Record<string, string> = {
  embargo: "Embargo",
  subasta_judicial: "Subasta judicial",
  herencia_yacente: "Herencia yacente",
  deuda_comunidad: "Deuda comunidad",
  construccion_ilegal: "Construcción ilegal",
  litigio: "Litigio",
  unfinished_construction: "Obra inacabada",
  structural_damage: "Daño estructural",
};

export interface RedFlag {
  type: RedFlagType;
  /** What the investor should check (legal OR physical), in the model's own words. */
  description: string;
  /** Literal quote from one advert — never empty; unevidenced flags are dropped. */
  evidence: string;
  /** Which portal that quote came from, so the investor can go and check it. */
  evidence_source: string | null;
}

export interface RedFlagsResult {
  /** Empty when nothing is flagged — a normal, expected result (EC-2). */
  flags: RedFlag[];
  /** Overall confidence in this reading; not per-flag (the list is binary — found/not). */
  confidence: number;
  reasoning: string;
}

function parseFlag(node: unknown): RedFlag | null {
  if (typeof node !== "object" || node === null) return null;
  const o = node as Record<string, unknown>;

  const evidence = typeof o.evidence === "string" ? o.evidence.trim() : "";
  // No citation, no flag (module doc: this is the code-side backstop against
  // a model asserting a legal risk from silence).
  if (evidence === "") return null;

  const rawType = typeof o.type === "string" ? o.type : "other";
  const type = ((REDFLAG_TYPES as readonly string[]).includes(rawType)
    ? rawType
    : "other") as RedFlagType;

  const description = typeof o.description === "string" ? o.description : "";
  const evidence_source =
    typeof o.evidence_source === "string" && o.evidence_source.trim() !== ""
      ? o.evidence_source
      : null;

  return { type, description, evidence, evidence_source };
}

/** Parse and validate the model's JSON into the red-flags result. */
export function parseRedFlagsResult(raw: string): RedFlagsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Redflags flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Redflags flow returned a non-object JSON value.");
  }

  const o = parsed as Record<string, unknown>;
  // A missing or non-array `flags` is NOT "nothing to flag" — it's a
  // malformed/off-schema response (truncation, a refusal wrapped in JSON,
  // prompt drift to a differently-named field like `red_flags`/`findings`).
  // Silently coercing it to [] used to carry the model's stated confidence
  // through unchanged, so e.g. `{"flags":"ninguna","confidence":0.9}` became
  // `{flags: [], confidence: 0.9}` — shape-identical to a genuine clean read
  // (#168 review, must-fix 1). Same treatment as non-JSON output above: throw
  // so the caller re-runs rather than persists a false "legally clean"
  // verdict. This is the parse-path counterpart of the guard `assessProperty
  // RedFlags` already has on the load path (module doc, above).
  if (!Array.isArray(o.flags)) {
    throw new Error(
      `Redflags flow returned a non-array 'flags': ${raw.slice(0, 200)}`,
    );
  }
  const flags = o.flags
    .map(parseFlag)
    .filter((f): f is RedFlag => f !== null);

  const confidence =
    typeof o.confidence === "number" ? clamp01(o.confidence) : 0;

  return {
    flags,
    confidence,
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * Persist a verdict, replacing any prior one for the same prompt version.
 * `contentHash` (#30) defaults to NULL for direct callers that don't compute
 * one — see occupancy.ts's `saveOccupancyAssessment` doc for the same note.
 */
export async function saveRedFlagsAssessment(
  propertyId: number,
  result: RedFlagsResult,
  model: string | null,
  contentHash: string | null = null,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, content_hash, generated_at)
     VALUES ($1, 'redflags', $2::jsonb, $3, $4, $5, $6, NOW())
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
      REDFLAGS_PROMPT_VERSION,
      contentHash,
    ],
  );
}

/**
 * Read the cached verdict for a property, if one exists.
 * #30: latest row regardless of prompt_version, with `stale` — see
 * occupancy.ts's `getOccupancyAssessment` doc for the full rationale.
 */
export async function getRedFlagsAssessment(
  propertyId: number,
): Promise<CachedAssessment<RedFlagsResult> | null> {
  return getLatestAssessment<RedFlagsResult>(
    propertyId,
    "redflags",
    REDFLAGS_PROMPT_VERSION,
  );
}

/**
 * Assess one property end-to-end: load its merged listings, ask the model
 * (unless an unchanged verdict is already cached — #30), validate, persist.
 *
 * Throws `NoListingsError` when the property has no live listings, OR when
 * every live listing has no description (see `loadPropertyListings`) — there
 * is nothing to read, and an empty `flags: []` written from that state would
 * be indistinguishable from "we read it and it's clean", which is a
 * materially different (and false) claim.
 *
 * #184: computes the bucketed zone-price signal ONCE (`buildAreaPriceSignal`,
 * price-signal.ts) and threads the exact same string into both the LLM call
 * (`extractRedFlags`'s `opts.areaPriceSignal` → rendered into the prompt) and
 * `getOrCompute`'s `extraHashInput` (→ folded into the cache's invalidation
 * key). Same variable, same call — the agreement the issue requires can't
 * drift apart because there is only one place either value comes from.
 */
export async function assessPropertyRedFlags(
  propertyId: number,
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<RedFlagsResult> {
  const listings = await loadPropertyListings(propertyId);
  if (listings.length === 0) throw new NoListingsError(propertyId);

  const areaPriceSignal = await buildAreaPriceSignal(propertyId);

  const { result, fromCache } = await getOrCompute<RedFlagsResult>(
    propertyId,
    "redflags",
    REDFLAGS_PROMPT_VERSION,
    listings,
    async () => {
      const { text, model } = await extractRedFlags(listings, { ...opts, areaPriceSignal });
      return { result: parseRedFlagsResult(text), model };
    },
    saveRedFlagsAssessment,
    areaPriceSignal,
  );
  logCacheOutcome("redflags", propertyId, fromCache);
  return result;
}

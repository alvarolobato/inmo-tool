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
import type { RedflagTrendingCandidate, DismissedCandidate } from "@/lib/llm-context/types";
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
 *
 * Bumped to v5 for #394 (Fase 6 of #385): the prompt now asks the model, when
 * it emits an `other` flag (nothing in the closed vocabulary fits), to ALSO
 * propose a `candidate_type` — a short snake_case slug — plus a one-line
 * definition, so the long tail of `other` flags becomes groupable data instead
 * of free prose (step 1 of the hybrid dynamic-tagging mechanism). No DB schema
 * change: `candidate_type` is one more field inside the existing
 * `redflags.flags[]` JSON. #308's batch re-assesses existing rows so `other`
 * flags gain their slug.
 *
 * Bumped to v6 for #396 (Fase 7 of #385): the redflags prompt now renders the
 * closed vocabulary FROM the `REDFLAG_TYPES`/`REDFLAG_LABELS`/`REDFLAG_DEFINITIONS`
 * enum (instead of duplicating it as fixed prose) AND injects the top-N trending
 * `other`-flag `candidate_type` slugs already seen across stored assessments, so
 * the model reuses an existing candidate before coining a synonym. Both change
 * what the model reads, so a v5 cache row must not silently pass as current;
 * #308's batch re-assesses existing rows against the new version.
 *
 * Bumped to v7 for #407: the redflags prompt now (a) injects the FULL cross-axis
 * vocabulary (occupancy/transaction/ownership/condition/location/opportunity),
 * rendered from each axis's enum, so the model maps a finding to an existing
 * concept instead of coining a duplicate `candidate_type` (the owner saw
 * `sin_posesion`, `regimen_vpo`, `venta_deuda`, `nuda_propiedad` invented as new
 * candidates), and (b) injects the human-dismissed candidate slugs as
 * "previously reviewed and rejected — do NOT propose these again". Both change
 * what the model reads, so a v6 cache row must not silently pass as current;
 * #308's batch re-assesses existing rows against the new version.
 */
export const REDFLAGS_PROMPT_VERSION = "redflags/v7";

/**
 * The closed vocabulary (types, labels, one-line definitions) lives in the leaf
 * module `redflag-vocabulary.ts` (no `pg`/LLM imports) so the prompt builder can
 * import it without the system-prompt → redflags → llm → llm-context cycle.
 * Re-exported here so existing importers keep using `@/lib/ai-assessment/redflags`.
 */
export {
  REDFLAG_TYPES,
  REDFLAG_LABELS,
  REDFLAG_DEFINITIONS,
  type RedFlagType,
} from "./redflag-vocabulary";
import { REDFLAG_TYPES, type RedFlagType } from "./redflag-vocabulary";

export interface RedFlag {
  type: RedFlagType;
  /** What the investor should check (legal OR physical), in the model's own words. */
  description: string;
  /** Literal quote from one advert — never empty; unevidenced flags are dropped. */
  evidence: string;
  /** Which portal that quote came from, so the investor can go and check it. */
  evidence_source: string | null;
  /**
   * #394 (Fase 6 of #385) — for `other` flags ONLY: a normalized snake_case
   * slug the model proposes as a name for a problem the closed vocabulary
   * doesn't cover (step 1 of the hybrid dynamic-tagging mechanism). Present
   * only when `type === 'other'` and the model returned a usable slug; named
   * types leave it `undefined`. NOT a filter and never rendered to end users
   * yet — it exists so the long tail of `other` flags can be grouped by slug
   * and, once a slug trends, promoted to the closed vocabulary by a human
   * (Fase 8). Normalized deterministically from what the model returns
   * (`normalizeCandidateType`), never regex-derived from the advert text — the
   * detection is still the model's job (cf. D-095).
   */
  candidate_type?: string;
  /**
   * #399 (Fase 8 of #385) — for `other` flags ONLY: the model's one-line
   * definition of the `candidate_type` it just coined (the prompt asks for it
   * alongside the slug). Persisted so the promotion page (`/admin/candidatos`)
   * can show the owner what each recurring slug is supposed to mean before they
   * decide whether to promote it. Present only when `type === 'other'` and the
   * model returned a non-empty string; named types leave it `undefined`. Like
   * `candidate_type` it is descriptive metadata, never a filter.
   */
  candidate_definition?: string;
}

/**
 * #394 — deterministically normalize the model's proposed `other` slug into a
 * stable snake_case key we can group by. This is a pure string utility over
 * what the LLM RETURNS — NOT a keyword/regex classifier of the advert text
 * (that classification stays the model's job; same principle as D-095's
 * LLM-only detection).
 *
 * NFKD accent-fold ("Ático Añadido" → "atico anadido"), lowercase, collapse
 * every run of non-alphanumerics (spaces, hyphens, punctuation) to a single
 * `_`, and trim leading/trailing `_`. A slug that normalizes to empty (the
 * model returned "", whitespace, or pure punctuation) degrades to `undefined`
 * so the flag stays a valid plain `other` rather than carrying a junk key.
 */
export function normalizeCandidateType(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const slug = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accent marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // collapse non-alphanumerics to a single _
    .replace(/^_+|_+$/g, ""); // trim leading/trailing _
  return slug === "" ? undefined : slug;
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

  // #394: only `other` carries a candidate_type — the model's proposed name for
  // a problem the closed vocabulary doesn't cover. Normalized deterministically
  // from what the model returned (never regex-derived from the advert text). A
  // malformed/empty slug degrades to undefined, leaving a valid plain `other`.
  const candidate_type =
    type === "other" ? normalizeCandidateType(o.candidate_type) : undefined;

  // #399: only `other` carries a candidate_definition — the model's one-line
  // gloss for the slug it coined. Kept only when the slug survived normalization
  // (a definition without a usable slug has nothing to attach to). Descriptive
  // metadata for the promotion page, never a filter.
  const candidate_definition =
    type === "other" && candidate_type !== undefined && typeof o.definition === "string"
      ? o.definition.trim() || undefined
      : undefined;

  return { type, description, evidence, evidence_source, candidate_type, candidate_definition };
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
 *
 * #396: `opts.trendingCandidates` — the top-N trending `other`-flag
 * `candidate_type` slugs — is computed ONCE per batch by the orchestrator
 * (`runAssessmentBatch`, batch.ts) and threaded straight through to the prompt
 * builder. It is NOT queried here (that would run once per property); this flow
 * only forwards what it is given. Deliberately NOT folded into
 * `getOrCompute`'s `extraHashInput`: the trending list is prompt CONTEXT that
 * changes as the corpus grows, and re-hashing every property whenever any new
 * candidate appears would needlessly invalidate the whole cache. The
 * `REDFLAGS_PROMPT_VERSION` bump (v6) is the single, deliberate invalidation
 * point for this prompt change.
 */
export async function assessPropertyRedFlags(
  propertyId: number,
  opts?: {
    requestId?: string | null;
    ctx?: LlmAgenticContext;
    trendingCandidates?: RedflagTrendingCandidate[];
    dismissedCandidates?: DismissedCandidate[];
  },
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
      const { text, model } = await extractRedFlags(listings, {
        ...opts,
        areaPriceSignal,
      });
      return { result: parseRedFlagsResult(text), model };
    },
    saveRedFlagsAssessment,
    areaPriceSignal,
  );
  logCacheOutcome("redflags", propertyId, fromCache);
  return result;
}

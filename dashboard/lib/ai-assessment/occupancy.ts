/**
 * #25 + #145 — "what do I actually get if I buy this?", per deduplicated
 * property.
 *
 * Answers the question the owner cares about most, along three independent
 * axes (see `OccupancyResult`): can I take possession, am I buying the property
 * or the debt, and am I buying all of it or a share. Each is a reason a
 * property is priced far below apparent market value, and an investor tool that
 * surfaces a cheap-looking flat without flagging that it is a credit assignment
 * or a bare-ownership share is actively misleading — which makes this flow the
 * highest-value thing the AI layer does (issue #1 §9, #145).
 *
 * The flow, the `assessment_type`, and the route stay named `occupancy` even
 * though it now covers three axes: the name is load-bearing across the #24 flow
 * catalog, D-006, the `assessment_type` CHECK and the API path, and renaming it
 * buys nothing a doc comment cannot.
 *
 * Two design points that are load-bearing rather than incidental:
 *
 *  1. **Per property, after dedup — never per listing during ingest.** The same
 *     flat on three portals is one physical thing with one true occupancy
 *     status. Assessing per listing meant three LLM calls, three bills, and
 *     three verdicts that could disagree with nothing to reconcile them.
 *
 *  2. **The union of the merged descriptions is the input.** Occupancy is
 *     exactly the fact one seller discloses and another omits, so reading all
 *     the adverts together is strictly better evidence than reading any one of
 *     them. That is only reachable once dedup has unioned the listings, which
 *     is why this runs at the end of the pipeline.
 *
 * Server-only: imports lib/db-write (the `pg` client). Never import from a
 * client component.
 */

import { sql } from "@/lib/db-write";
import { assessOccupancy } from "@/lib/llm";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import {
  NoListingsError,
  loadPropertyListings,
  parseVerdict as parseVerdictBase,
  stripCodeFence,
  type Verdict,
} from "./shared";
import { getOrCompute, getLatestAssessment, type CachedAssessment } from "./cache";

// Re-exported so existing imports (`from "../occupancy"`, including this
// flow's own tests) keep working unchanged now that the property-loading and
// parsing plumbing is shared with #26/#27.
export { NoListingsError, loadPropertyListings };
export type { Verdict };

/**
 * Prompt version. Bump when the occupancy prompt changes in a way that could
 * change a verdict, so `ai_assessment`'s unique key treats the new output as a
 * distinct row rather than colliding with a verdict the old prompt produced.
 * #30 owns the wider caching/versioning story; this is the hook it will use.
 */
export const OCCUPANCY_PROMPT_VERSION = "occupancy/v1";

/** Occupancy status vocabulary — see the enum-language note in system-prompt.ts. */
export const OCCUPANCY_STATUSES = [
  "vacant",
  "tenanted",
  "occupied_illegally",
  "unknown",
] as const;

export type OccupancyStatus = (typeof OCCUPANCY_STATUSES)[number];

/** What legal instrument is being transferred (#145). */
export const TRANSACTION_KINDS = ["compraventa", "venta_deuda", "unknown"] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** How much of the right is being transferred (#145). */
export const OWNERSHIP_EXTENTS = [
  "pleno_dominio",
  "nuda_propiedad",
  "usufructo",
  "proindiviso",
  "derecho_superficie",
  "unknown",
] as const;

export type OwnershipExtent = (typeof OWNERSHIP_EXTENTS)[number];

/**
 * Every non-standard condition found, as flat codes for cheap filtering and
 * badging. Derived from the three axes in `deriveCaveats()` — never taken from
 * the model — so a badge can never disagree with the verdict it summarises.
 */
export const CAVEAT_CODES = [
  "tenanted",
  "occupied_illegally",
  "venta_deuda",
  "nuda_propiedad",
  "usufructo",
  "proindiviso",
  "derecho_superficie",
] as const;

export type CaveatCode = (typeof CAVEAT_CODES)[number];

/**
 * The three axes of "what do I actually get if I buy this?" (#25 + #145).
 *
 * Deliberately three sibling verdicts rather than one enum: they are
 * independent, they co-occur in the wild, and a flat enum cannot represent
 * "squatted debt sale of a 50% share" — which is a listing that really exists.
 * Each axis carries its own confidence and its own cited evidence, because the
 * phrase proving the flat is squatted is rarely the phrase proving it is a
 * credit assignment.
 */
export interface OccupancyResult {
  /** Can I take possession? */
  occupancy: Verdict<OccupancyStatus>;
  /** Am I buying the property, or the debt secured on it? */
  transaction: Verdict<TransactionKind>;
  /** Am I buying the whole right, or a share / limited right of it? */
  ownership: Verdict<OwnershipExtent> & {
    /** Percentage being sold when stated ("el 50%" → 50), else null. */
    share_pct: number | null;
  };
  /** Derived, not model-authored. See CAVEAT_CODES. */
  caveats: CaveatCode[];
  reasoning: string;
}

/**
 * Local wrapper around the shared `parseVerdict`: every occupancy axis
 * degrades to literal `"unknown"` (not a per-flow fallback), so this pins
 * that argument rather than repeating it at each of the three call sites
 * below.
 */
function parseVerdict<T extends string>(
  node: unknown,
  key: string,
  allowed: readonly T[],
  silenceDefault?: T,
): Verdict<T> {
  return parseVerdictBase(node, key, allowed, "unknown" as T, silenceDefault);
}

/**
 * Every non-standard condition present, derived from the three axes.
 *
 * Computed here rather than asked of the model so the summary and the verdicts
 * it summarises always come from one computation and cannot drift apart (the
 * same rule `explainScore()` follows for rank_explanation).
 *
 * `unknown` never produces a caveat: absence of evidence is not evidence of a
 * problem, and a caveat badge implies we found something.
 */
export function deriveCaveats(
  occupancy: OccupancyStatus,
  transaction: TransactionKind,
  ownership: OwnershipExtent,
): CaveatCode[] {
  const caveats: CaveatCode[] = [];
  if (occupancy === "tenanted" || occupancy === "occupied_illegally") {
    caveats.push(occupancy);
  }
  if (transaction === "venta_deuda") caveats.push("venta_deuda");
  if (ownership !== "pleno_dominio" && ownership !== "unknown") {
    caveats.push(ownership);
  }
  return caveats;
}

/** Parse and validate the model's JSON into the three-axis result. */
export function parseOccupancyResult(raw: string): OccupancyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Occupancy flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Occupancy flow returned a non-object JSON value.");
  }

  const o = parsed as Record<string, unknown>;

  // No silenceDefault for occupancy: per the eje-1 prompt rule, silence
  // forces `unknown`, not a clamped `vacant` — there is nothing to cap.
  //
  // KNOWN GAP (#168 review, noted rather than fixed here): eje 1 has the same
  // missing "no citation, no assertion" backstop that condition.ts had before
  // #168 — a model could report `{status: "tenanted", confidence: 0.9,
  // evidence: ""}` and it would write through unchanged, same as condition's
  // must-fix. Deliberately NOT applying condition's fix here in this pass:
  // several existing tests (occupancy.test.ts's `parseOccupancyResult`/
  // `summaryConfidence` suites) construct axis-1 verdicts with an omitted
  // `evidence` field expecting them to pass through, and eje 1 additionally
  // has no single "default" value to fall back to the way condition falls
  // back to `unclear` (`unknown` already means "no signal at all", which is
  // a different claim than "a signal existed but wasn't quoted"). Fixing
  // this properly means auditing/updating those tests and deciding what an
  // uncited `tenanted`/`occupied_illegally` degrades to — worth its own pass
  // rather than folding into #26's fix. Filed against issue #25/#145.
  const occupancy = parseVerdict(o.occupancy, "status", OCCUPANCY_STATUSES);
  const transaction = parseVerdict(
    o.transaction,
    "kind",
    TRANSACTION_KINDS,
    "compraventa",
  );
  const ownershipBase = parseVerdict(
    o.ownership,
    "extent",
    OWNERSHIP_EXTENTS,
    "pleno_dominio",
  );

  const ownershipNode = (
    typeof o.ownership === "object" && o.ownership !== null ? o.ownership : {}
  ) as Record<string, unknown>;

  return {
    occupancy,
    transaction,
    ownership: {
      ...ownershipBase,
      share_pct: parseSharePct(ownershipNode.share_pct),
    },
    caveats: deriveCaveats(occupancy.value, transaction.value, ownershipBase.value),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * A share percentage is only meaningful in [1, 100]. Anything else — a stray
 * 0, a 150, a string, a fraction the model wrote as 0.5 meaning "50%" — is
 * dropped to null rather than guessed at: a wrong share is worse than a
 * missing one when it is what tells the investor they are buying half a flat.
 *
 * The lower bound is 1, not 0 (#156 review, nice-to-have): no real
 * `proindiviso` sale trades a sub-1% stake, so a value below 1 is
 * overwhelmingly a model writing the fraction form of a percentage
 * (0.5 meaning 50%, not "0.5%") rather than a genuine tiny share. Storing it
 * literally would silently understate the share by ~100x, which is the wrong
 * kind of confident wrong this function exists to prevent.
 */
function parseSharePct(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 1 || v > 100) return null;
  return v;
}

/**
 * What goes in the `ai_assessment.confidence` COLUMN when the row holds three
 * independent verdicts.
 *
 * There is no honest single number, so rather than invent a composite the
 * column carries **the confidence of the finding that matters** — the highest
 * confidence among the axes that produced a caveat, or the occupancy
 * confidence when the property is clean. That keeps a coarse SQL filter like
 * `confidence > 0.7` meaning "we are sure about what we found", instead of
 * averaging a confident `venta_deuda` away against an `unknown` occupancy.
 *
 * Anything needing per-axis precision reads `result`, which keeps all three.
 */
export function summaryConfidence(result: OccupancyResult): number {
  const flagged: number[] = [];
  if (
    result.occupancy.value === "tenanted" ||
    result.occupancy.value === "occupied_illegally"
  ) {
    flagged.push(result.occupancy.confidence);
  }
  if (result.transaction.value === "venta_deuda") {
    flagged.push(result.transaction.confidence);
  }
  if (
    result.ownership.value !== "pleno_dominio" &&
    result.ownership.value !== "unknown"
  ) {
    flagged.push(result.ownership.confidence);
  }
  return flagged.length > 0 ? Math.max(...flagged) : result.occupancy.confidence;
}

/**
 * Persist a verdict, replacing any prior one for the same prompt version.
 *
 * `contentHash` (#30) is optional — omitted, it is stored as NULL, which
 * `getOrCompute` (cache.ts) always treats as a miss on the next read. Direct
 * callers that only care about the row shape (tests, `saveOccupancyAssessment`
 * used outside `assessPropertyOccupancy`) can keep passing 3 args unchanged.
 */
export async function saveOccupancyAssessment(
  propertyId: number,
  result: OccupancyResult,
  model: string | null,
  contentHash: string | null = null,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, content_hash, generated_at)
     VALUES ($1, 'occupancy', $2::jsonb, $3, $4, $5, $6, NOW())
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
      OCCUPANCY_PROMPT_VERSION,
      contentHash,
    ],
  );
}

/**
 * Read the cached verdict for a property, if one exists.
 *
 * #30: now selects the LATEST row for (property_id, 'occupancy') regardless
 * of `prompt_version` (see `getLatestAssessment`'s doc for why — the #156-era
 * behaviour of filtering strictly by the current version made GET 404 right
 * after a prompt bump even though `lib/candidates.ts`'s card query would still
 * show the old verdict). `stale` tells the caller whether the row it got back
 * was generated under a version that is no longer current.
 */
export async function getOccupancyAssessment(
  propertyId: number,
): Promise<CachedAssessment<OccupancyResult> | null> {
  return getLatestAssessment<OccupancyResult>(
    propertyId,
    "occupancy",
    OCCUPANCY_PROMPT_VERSION,
  );
}

/**
 * Assess one property end-to-end: load its merged listings, ask the model
 * (unless an unchanged verdict is already cached — #30), validate, persist.
 *
 * Throws `NoListingsError` when the property has no live listings, OR when
 * every live listing has no description (see `loadPropertyListings`) — in
 * both cases there is nothing to read, and writing a verdict (`unknown` or
 * otherwise) would misrepresent "we never looked" as "we looked and could
 * not tell" or, worse on the #145 axes, as a confident all-clear.
 */
export async function assessPropertyOccupancy(
  propertyId: number,
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<OccupancyResult> {
  const listings = await loadPropertyListings(propertyId);
  if (listings.length === 0) throw new NoListingsError(propertyId);

  const { result } = await getOrCompute<OccupancyResult>(
    propertyId,
    "occupancy",
    OCCUPANCY_PROMPT_VERSION,
    listings,
    async () => {
      const { text, model } = await assessOccupancy(listings, opts);
      return { result: parseOccupancyResult(text), model };
    },
    saveOccupancyAssessment,
  );
  return result;
}

/**
 * #542 (docs/roadmap/llm-batching-plan.md, Phase 2 PR 2a, decision D-A) —
 * `triage`: condition + location + opportunity merged into ONE LLM call.
 *
 * Before this, `condition`/`location`/`opportunity` were three independent
 * property-level flows (#26/#388/#398), each its own prompt, each its own
 * `assessProperty*` entry point, each its own `getOrCompute` cache check —
 * three LLM calls (and up to three CLI spawns) to answer three cheap,
 * closed-vocabulary questions about the SAME payload (every live listing of
 * one deduplicated property). `docs/roadmap/llm-batching-plan.md` §2 D-A
 * merges them into one call whose prompt (`buildTriagePrompt`,
 * `lib/llm-context/system-prompt.ts`) asks for all three and returns a JSON
 * ARRAY keyed by an echoed `property_id` — N-property-capable from day one,
 * even though every caller here sends exactly one (N=1); Phase 3 of the plan
 * is what turns on real multi-property packing, with no further prompt
 * change.
 *
 * ## What did NOT change
 *
 * Every per-axis parser (`parseConditionObject`/`parseLocationObject`/
 * `parseOpportunityObject`) keeps its OWN vocabulary, evidence-or-fallback
 * backstop and degrade rules exactly as before the merge — this module calls
 * them unchanged on each axis's already-parsed sub-object (the JSON.parse
 * step is hoisted to the whole array response, see `parseTriageResponse`).
 * Three `ai_assessment` rows are still written — same `assessment_type`
 * values, same result shapes, same `save*Assessment` functions — so every
 * existing reader (`loadFlags`, `candidates.ts`, the card badges, D-059's
 * filters, D-067's extract fallback, the GET routes) keeps working with ZERO
 * changes; a triage-written row is indistinguishable from a pre-merge row.
 *
 * ## Terreno handling (D-095/#398, unchanged)
 *
 * `condition` applies to every property type; `location`/`opportunity` do
 * NOT apply to a `terreno` (bare plot) — `applicableAxes` mirrors
 * `location.ts`'s `locationApplies`/`opportunity.ts`'s `opportunityApplies`
 * (identical `!== "terreno"` check). A terreno's triage call requests
 * `["condition"]` only and writes no location/opportunity row — identical
 * observable behavior to the pre-merge skip path.
 *
 * ## The evidence-substring guard (new — batching plan §2 D-B, applied here
 * even at N=1)
 *
 * Merging three axes into one completion raises a new failure mode a
 * single-axis call never had: cross-axis evidence bleed, where the model
 * cites a plausible-sounding quote for one axis that was actually said about
 * (or invented for) another. Every axis already refuses to assert a claim
 * with no evidence quote at all (D-056/D-095's evidence-or-fallback rule) —
 * this adds one more check, code-side, never trusted to the prompt: an
 * axis's evidence quote must appear as a literal SUBSTRING of the SAME
 * property's own listing text, or it is treated exactly like an empty quote
 * (`sanitizeEvidenceFields` blanks it BEFORE the axis's own parser runs, so
 * every existing degrade path — `unclear`/confidence 0 for condition,
 * `none`/`false` per signal for location/opportunity — fires unchanged). One
 * axis's failed check never touches another axis's fields.
 *
 * ## Always request every applicable axis
 *
 * Every entry point (`assessPropertyCondition`/`Location`/`Opportunity`, and
 * the batch scheduler's `triage` flow) calls `assessPropertyTriage` with NO
 * axis subset argument — the applicable set (all three, or just `condition`
 * for a terreno) is always requested. `getOrComputeMulti` (`./cache`) then
 * narrows that to genuine misses before spending anything: an operator
 * hitting `POST /assessments/condition` on a property whose location/
 * opportunity happen to be stale ALSO gets those refreshed in the same call
 * — "strictly better for the operator" per the decision record, and the
 * reason there is exactly one "which axes to ask about" policy, not one per
 * caller.
 *
 * Server-only: transitively imports `lib/db-write` (the `pg` client). Never
 * import from a client component.
 */

import { assessTriage } from "@/lib/llm";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import type { ListingSnapshot, TriageAxis, TriagePropertyInput } from "@/lib/llm-context";
import { NoListingsError, loadPropertyListings, stripCodeFence } from "./shared";
import {
  getOrComputeMulti,
  AssessmentParkedError,
  type MultiAxisSpec,
  type MultiAxisComputed,
  type MultiAxisOutcome,
} from "./cache";
import {
  parseConditionObject,
  saveConditionAssessment,
  CONDITION_PROMPT_VERSION,
  type ConditionResult,
} from "./condition";
import {
  parseLocationObject,
  saveLocationAssessment,
  locationApplies,
  LOCATION_PROMPT_VERSION,
  type LocationResult,
} from "./location";
import {
  parseOpportunityObject,
  saveOpportunityAssessment,
  OPPORTUNITY_PROMPT_VERSION,
  type OpportunityResult,
} from "./opportunity";

export { NoListingsError, loadPropertyListings };
export type { TriageAxis, TriagePropertyInput };

/** Every axis `triage` covers, requested unless a terreno excludes location/opportunity. */
const ALL_TRIAGE_AXES: readonly TriageAxis[] = ["condition", "location", "opportunity"];

/**
 * Which axes apply to a property of this type (#398/#388, owner decision) —
 * identical `!== "terreno"` rule `location.ts`'s `locationApplies` and
 * `opportunity.ts`'s `opportunityApplies` each already enforce for their own
 * axis; reused here (via `locationApplies`) rather than a third copy of the
 * same one-line check.
 */
function applicableAxes(propertyType: string | null | undefined): readonly TriageAxis[] {
  return locationApplies(propertyType) ? ALL_TRIAGE_AXES : (["condition"] as const);
}

/** Fields on each axis's RAW (pre-parse) object that must cite the source text. */
const EVIDENCE_FIELDS: Record<TriageAxis, readonly string[]> = {
  condition: ["evidence"],
  location: ["beach_evidence", "heritage_evidence"],
  opportunity: ["vpo_evidence", "tourist_license_evidence"],
};

/**
 * Blank any listed evidence field whose value is a non-empty string that
 * does NOT appear verbatim in `corpus` — the evidence-substring guard (see
 * module doc). Returns `raw` unchanged (same reference) when nothing needed
 * blanking, so the common case allocates nothing.
 */
function sanitizeEvidenceFields(
  raw: Record<string, unknown>,
  fields: readonly string[],
  corpus: string,
): Record<string, unknown> {
  let out = raw;
  for (const field of fields) {
    const v = raw[field];
    if (typeof v === "string" && v.trim() !== "" && !corpus.includes(v)) {
      if (out === raw) out = { ...raw };
      out[field] = "";
    }
  }
  return out;
}

/** Concatenation of a property's own listing descriptions — the evidence-substring guard's source of truth. */
function corpusOf(listings: ListingSnapshot[]): string {
  return listings.map((l) => l.description ?? "").join("\n");
}

/**
 * Parse the triage array response into one raw entry per REQUESTED property
 * id — nothing about the individual axis objects is validated here (that is
 * each axis's own `parse*Object`); this layer only owns:
 *
 *   - the top-level JSON.parse/fence-strip (hoisted up from the three old
 *     per-axis string parsers — see module doc);
 *   - ECHOED-ID validation: an entry whose `property_id` is not a finite
 *     integer, or does not match one of `requestedIds`, is DROPPED (logged);
 *   - DUPLICATE ids: the FIRST entry for a given id wins, later ones for the
 *     same id are dropped (logged);
 *   - MISSING ids: a requested id with no entry at all simply has no key in
 *     the returned map — the caller (`computeTriageBatch`) treats that as
 *     "no usable entry for any of this property's requested axes", which
 *     `getOrComputeMulti` turns into a per-axis `"error"` outcome.
 *
 * Throws on genuinely non-JSON or non-array output — mirroring the single-
 * axis parsers' "non-JSON output" throw — because that failure applies to
 * the WHOLE response, not to one property or axis.
 */
export function parseTriageResponse(
  raw: string,
  requestedIds: readonly number[],
): Map<number, Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Triage flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Triage flow returned a non-array JSON value.");
  }

  const requested = new Set(requestedIds);
  const byId = new Map<number, Record<string, unknown>>();

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      console.warn("[ai-assessment:triage] dropping a non-object array entry.");
      continue;
    }
    const o = entry as Record<string, unknown>;
    const rawId = o.property_id;
    const propertyId = typeof rawId === "number" && Number.isInteger(rawId) ? rawId : null;
    if (propertyId === null) {
      console.warn(
        `[ai-assessment:triage] dropping an entry with an invalid property_id: ${JSON.stringify(rawId)}`,
      );
      continue;
    }
    if (!requested.has(propertyId)) {
      console.warn(`[ai-assessment:triage] dropping an entry for an unrequested property_id=${propertyId}.`);
      continue;
    }
    if (byId.has(propertyId)) {
      console.warn(`[ai-assessment:triage] duplicate entry for property_id=${propertyId} — keeping the first.`);
      continue;
    }
    byId.set(propertyId, o);
  }

  return byId;
}

/** Extract, sanitize (evidence-substring guard) and parse one axis's slice out of a raw entry, or `undefined` if absent/unusable. */
function parseAxisSlice(
  axis: TriageAxis,
  entry: Record<string, unknown>,
  corpus: string,
): { result: unknown } | undefined {
  const raw = entry[axis];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const sanitized = sanitizeEvidenceFields(raw as Record<string, unknown>, EVIDENCE_FIELDS[axis], corpus);
  switch (axis) {
    case "condition":
      return { result: parseConditionObject(sanitized) };
    case "location":
      return { result: parseLocationObject(sanitized) };
    case "opportunity":
      return { result: parseOpportunityObject(sanitized) };
  }
}

/** One property's request into {@link parseTriageArray} — echo/dedup/degrade all key off this. */
export interface TriageParseRequest {
  propertyId: number;
  /** Axes to extract for this property — extras present in the raw response are ignored (defense in depth beyond the prompt instruction; see the terreno case). */
  axes: readonly TriageAxis[];
  /** This property's own listings — `corpusOf` derives the evidence-substring guard's source of truth from them. */
  listings: ListingSnapshot[];
}

/** What {@link parseTriageArray} resolves for one property — only the axes it actually parsed successfully are present. */
export interface TriageParsedProperty {
  condition?: ConditionResult;
  location?: LocationResult;
  opportunity?: OpportunityResult;
}

/**
 * Parse + validate a triage array RESPONSE against what was actually
 * requested: echoed-id validation/dedup/unknown-id dropping (delegates to
 * {@link parseTriageResponse}), then per-property, per-axis extraction with
 * the evidence-substring guard (`sanitizeEvidenceFields`) and each axis's own
 * parser (`parseConditionObject`/`parseLocationObject`/`parseOpportunityObject`
 * — UNCHANGED). A requested property absent from the response has NO entry in
 * the returned map at all (a "missing id"); a requested axis whose slice is
 * absent or unusable is simply absent from that property's
 * `TriageParsedProperty` (per-axis degradation isolation — a bad `location`
 * slice never removes a good `condition` one).
 *
 * Exported primarily so this whole chain is unit-testable without a live LLM
 * (see `triage.test.ts`'s echoed-id/duplicate/unknown/missing-id, per-axis-
 * isolation, evidence-substring-guard and terreno-slice tests).
 * `computeTriageBatch` (the real `getOrComputeMulti` `computeFn`) is a thin
 * wrapper that also makes the actual call.
 */
export function parseTriageArray(
  raw: string,
  requests: readonly TriageParseRequest[],
): Map<number, TriageParsedProperty> {
  const byId = parseTriageResponse(
    raw,
    requests.map((r) => r.propertyId),
  );

  const out = new Map<number, TriageParsedProperty>();
  for (const req of requests) {
    const entry = byId.get(req.propertyId);
    if (!entry) continue; // missing id: no entry for this property at all

    const corpus = corpusOf(req.listings);
    const parsed: TriageParsedProperty = {};
    for (const axis of req.axes) {
      const slice = parseAxisSlice(axis, entry, corpus);
      if (!slice) continue; // this axis's slice was unusable — isolated to it
      if (axis === "condition") parsed.condition = slice.result as ConditionResult;
      else if (axis === "location") parsed.location = slice.result as LocationResult;
      else parsed.opportunity = slice.result as OpportunityResult;
    }
    out.set(req.propertyId, parsed);
  }
  return out;
}

/**
 * The `computeFn` `getOrComputeMulti` calls on a genuine miss: sends ONE
 * triage call for the given axes (N=1 property, this PR), then delegates to
 * {@link parseTriageArray}. Never throws for a per-axis shape gap (that is
 * `getOrComputeMulti`'s job, via a missing map key) — only for a whole-call
 * failure (network, budget, unparseable response), which propagates
 * unchanged so EC-3 (budget/circuit/quota) still reaches the batch loop.
 */
async function computeTriageBatch(
  propertyId: number,
  listings: ListingSnapshot[],
  axisKeys: string[],
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<Record<string, MultiAxisComputed | undefined>> {
  const axes = axisKeys as TriageAxis[];
  const property: TriagePropertyInput = { propertyId, listings, axes };

  const { text, model } = await assessTriage([property], opts);
  const parsed = parseTriageArray(text, [{ propertyId, axes, listings }]);
  const entry = parsed.get(propertyId);

  const out: Record<string, MultiAxisComputed | undefined> = {};
  if (!entry) return out; // every axis stays undefined -> per-axis "error" outcome

  for (const axis of axes) {
    const result = entry[axis];
    if (result !== undefined) out[axis] = { result, model };
  }
  return out;
}

async function saveAxis(
  key: string,
  propertyId: number,
  result: unknown,
  model: string | null,
  contentHash: string,
): Promise<void> {
  switch (key as TriageAxis) {
    case "condition":
      return saveConditionAssessment(propertyId, result as ConditionResult, model, contentHash);
    case "location":
      return saveLocationAssessment(propertyId, result as LocationResult, model, contentHash);
    case "opportunity":
      return saveOpportunityAssessment(propertyId, result as OpportunityResult, model, contentHash);
  }
}

/** Per-axis outcome `assessPropertyTriage` hands back to its three thin per-axis callers. */
export type TriageAxisResult<T> =
  | { status: "ok"; result: T; fromCache: boolean }
  | { status: "parked"; failCount: number; lastError: string | null }
  | { status: "error"; error: unknown }
  | { status: "not_applicable" };

export interface TriageResult {
  condition: TriageAxisResult<ConditionResult>;
  location: TriageAxisResult<LocationResult>;
  opportunity: TriageAxisResult<OpportunityResult>;
}

function toAxisResult<T>(outcome: MultiAxisOutcome<unknown> | undefined): TriageAxisResult<T> {
  if (!outcome) return { status: "not_applicable" };
  switch (outcome.status) {
    case "hit":
      return { status: "ok", result: outcome.result as T, fromCache: true };
    case "computed":
      return { status: "ok", result: outcome.result as T, fromCache: false };
    case "parked":
      return { status: "parked", failCount: outcome.failCount, lastError: outcome.lastError };
    case "error":
      return { status: "error", error: outcome.error };
  }
}

/**
 * Deliberately a FUNCTION, not a top-level `const` object — this module is
 * imported BACK FROM `./condition`/`./location`/`./opportunity` (each thin
 * per-axis wrapper calls `assessPropertyTriage`), so this file is on the
 * other side of a circular import. `CONDITION_PROMPT_VERSION` /
 * `LOCATION_PROMPT_VERSION` / `OPPORTUNITY_PROMPT_VERSION` are live ESM
 * bindings that resolve correctly once every module involved has finished
 * its OWN top-level evaluation — true by the time any exported function here
 * actually RUNS, but not necessarily true at this module's own load time (a
 * plain top-level `const` reading them right away could observe `undefined`
 * depending on which module the cycle enters from first). Computing this
 * inside a function, called only once real work starts, sidesteps the
 * ordering hazard entirely.
 */
function axisSpec(axis: TriageAxis): { assessmentType: TriageAxis; promptVersion: string } {
  switch (axis) {
    case "condition":
      return { assessmentType: "condition", promptVersion: CONDITION_PROMPT_VERSION };
    case "location":
      return { assessmentType: "location", promptVersion: LOCATION_PROMPT_VERSION };
    case "opportunity":
      return { assessmentType: "opportunity", promptVersion: OPPORTUNITY_PROMPT_VERSION };
  }
}

/**
 * Assess one property's condition + location + opportunity axes in ONE call
 * (unless every applicable axis is already cached or parked, in which case
 * NO call is made at all). Always requests every APPLICABLE axis — see
 * module doc "Always request every applicable axis".
 *
 * Throws `NoListingsError` when the property has no live listings, OR when
 * every live listing has no description (see `loadPropertyListings`) — same
 * 404 signal every other property-level flow uses. Never throws for a
 * per-axis park/error — those are reported per axis in the returned
 * `TriageResult`, so a bad `location` slice never stops `condition` (or
 * `opportunity`) from being returned to their own callers.
 */
export async function assessPropertyTriage(
  propertyId: number,
  opts?: {
    requestId?: string | null;
    ctx?: LlmAgenticContext;
    // Structurally accepted, silently ignored — the same "harmless no-op"
    // shape every other AssessmentOpts-typed flow already tolerates so this
    // function is assignable to `batch.ts`'s `BatchFlow.assess`.
    trendingCandidates?: unknown;
    dismissedCandidates?: unknown;
  },
): Promise<TriageResult> {
  const listings = await loadPropertyListings(propertyId);
  if (listings.length === 0) throw new NoListingsError(propertyId);

  const axes = applicableAxes(listings[0].propertyType);
  const specs: MultiAxisSpec[] = axes.map((axis) => ({ key: axis, ...axisSpec(axis) }));

  const outcomes = await getOrComputeMulti(
    propertyId,
    specs,
    listings,
    (missingKeys) => computeTriageBatch(propertyId, listings, missingKeys, opts),
    saveAxis,
  );

  return {
    condition: toAxisResult<ConditionResult>(outcomes.condition),
    location: toAxisResult<LocationResult>(outcomes.location),
    opportunity: toAxisResult<OpportunityResult>(outcomes.opportunity),
  };
}

/**
 * `batch.ts`'s `triage` `BatchFlow.assess` adapter. `assessPropertyTriage`
 * reports a park/error PER AXIS in its return value rather than by throwing
 * — that is what lets a bad `location` slice leave `condition`'s own
 * caller (e.g. `POST /assessments/condition`) with a usable result — but the
 * batch loop's summary counters (`assessed`/`parked`/`errors`,
 * `runAssessmentBatch` in this same directory) are driven entirely by
 * whether `flow.assess` throws, the SAME contract every other `BatchFlow`
 * entry follows (occupancy/redflags/extract). This adapter reconciles the
 * two without teaching the generic loop about triage's per-axis shape:
 *
 *   - an `"error"` on ANY axis is re-thrown first (a genuine content
 *     failure is a more actionable signal than a park already doing its
 *     job) — the batch counts the tick as `errors`;
 *   - else a `"parked"` on any axis re-throws `AssessmentParkedError` for
 *     the FIRST such axis — the batch counts it as `parked`;
 *   - else (every applicable axis is `ok`/`not_applicable`) returns
 *     normally — the batch counts it as `assessed`.
 *
 * This is a deliberate, coarse-grained trade-off: a tick where `condition`
 * was freshly computed while `location` happens to be parked is counted as
 * `parked`, not `assessed` — the alternative (silently treating a real park
 * or error as a clean `assessed` because SOME axis succeeded) would hide
 * exactly the signal D-104 exists to surface. See the triage decision
 * record for the full reasoning.
 */
export async function assessPropertyTriageForBatch(
  propertyId: number,
  opts?: {
    requestId?: string | null;
    ctx?: LlmAgenticContext;
    trendingCandidates?: unknown;
    dismissedCandidates?: unknown;
  },
): Promise<void> {
  const triage = await assessPropertyTriage(propertyId, opts);
  const axes: Array<[TriageAxis, TriageAxisResult<unknown>]> = [
    ["condition", triage.condition],
    ["location", triage.location],
    ["opportunity", triage.opportunity],
  ];

  for (const [, axis] of axes) {
    if (axis.status === "error") throw axis.error;
  }
  for (const [key, axis] of axes) {
    if (axis.status === "parked") {
      throw new AssessmentParkedError(propertyId, key, axis.failCount, axis.lastError);
    }
  }
  // Every applicable axis is `ok` (or `not_applicable` for a terreno) — a
  // normal return, counted as `assessed` by the batch loop.
}

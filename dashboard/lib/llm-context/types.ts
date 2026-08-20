/**
 * Flow catalog and per-flow inputs for buildSystemPrompt() / assembleRequest().
 *
 * Six named flows replace the inherited dashboard-generation catalog
 * (generate/modify/analyze/suggest/gap/weekly/summary/title), which belonged to
 * a BI dashboard builder and had no fit for a real-estate sourcing tool:
 *
 *   Single-shot, structured-output (JSON), no tools, no history:
 *     occupancy  — is the property occupied / tenanted / vacant?
 *     condition  — renovation state (obra nueva / reformado / a reformar)
 *     redflags   — legal & financial risk mentions (embargo, herencia, …)
 *     location   — beach proximity (graded) + heritage zone, from ad text (#388)
 *     opportunity — is_vpo (hard filter) + tourist_license (boost), from ad text (#398)
 *     extract    — pull structured fields out of a free-text description
 *     compare    — side-by-side comparison of N candidate properties
 *
 *   Conversational, tool-calling, with history:
 *     chat       — free-form questions over the ingested listing data
 *
 * Flows 4.2–4.7 (#25–#30) own the real prompt bodies; this module owns the
 * catalog, the dispatch, and the single-entry-point boundary (see
 * docs/decisions/D-006-llm-context-centralization.md).
 */

/** Every named flow assembleRequest() understands. */
export const LLM_FLOWS = [
  "occupancy",
  "triage",
  "redflags",
  "extract",
  "compare",
  "chat",
] as const;

export type LlmFlow = (typeof LLM_FLOWS)[number];

/**
 * Flows that produce a fixed-shape JSON answer in one round: no tool loop, no
 * conversation history. Cheaper and far more predictable than an agentic run
 * for what is really a structured-extraction task.
 */
export const SINGLE_SHOT_FLOWS: ReadonlySet<string> = new Set<string>([
  "occupancy",
  "triage",
  "redflags",
  "extract",
  "compare",
]);

export function isLlmFlow(value: string): value is LlmFlow {
  return (LLM_FLOWS as readonly string[]).includes(value);
}

/**
 * #396 (Fase 7 of #385) — one trending `other`-flag candidate slug, as computed
 * ONCE per assessment batch by `lib/db/redflag-candidates.ts`
 * (`getTrendingCandidateTypes`) and threaded into the redflags prompt so the
 * model sees what problem names have already been proposed before it coins a
 * new one (reducing synonym slugs like `obra_sin_acabar` vs the existing
 * `unfinished_construction`).
 *
 * Defined here — with `FlowVars` — because the prompt builder is the consumer
 * and stays pure (it receives the list as data, never queries the DB). The db
 * module imports this type only (no runtime coupling). NOT a filter and never
 * shown to end users; promotion of a trending slug to the closed vocabulary is
 * a separate, human step (Fase 8).
 */
export interface RedflagTrendingCandidate {
  /** Normalized snake_case slug the model previously proposed for an `other` flag. */
  candidateType: string;
  /** How many stored `other` flags carry this slug (drives the ORDER BY / threshold). */
  count: number;
}

/**
 * #407 — one `candidate_type` slug a human reviewed on `/admin/candidatos` and
 * explicitly DISMISSED (rejected as a real category). Threaded into the redflags
 * prompt so the model is told "previously reviewed and rejected — do NOT propose
 * these again", and excluded from the trending block and the promotion list so a
 * rejected slug stops resurfacing. Computed ONCE per batch by the orchestrator
 * (`lib/db/redflag-candidates.ts` → `getDismissedCandidateTypes`) and passed to
 * the pure prompt builder as data; never a filter on the advert text.
 */
export interface DismissedCandidate {
  /** The normalized snake_case slug the owner dismissed. */
  slug: string;
  /** The owner's optional one-line reason for dismissing it, or null. */
  reason: string | null;
}

/**
 * A listing as handed to an assessment flow. Deliberately a flat, source-
 * agnostic shape: assessments run identically whether the row arrived via a
 * crawling connector or the browser-extension capture path (#75).
 */
export interface ListingSnapshot {
  propertyId?: number;
  listingId?: number;
  source?: string;
  url?: string;
  title?: string;
  description?: string;
  /**
   * 'sale' | 'rent'. Load-bearing for occupancy: a rental listing is expected
   * to be tenanted, so the same wording ("actualmente alquilado") that flags a
   * sale listing as occupied is unremarkable on a rental. Without it the model
   * assesses a rental blind.
   */
  operation?: string | null;
  /** piso | chalet | local | nave | garaje | terreno | edificio | … */
  propertyType?: string | null;
  price?: number | null;
  m2Built?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  floor?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  yearBuilt?: number | null;
  energyRating?: string | null;
  features?: string[];
  photoUrls?: string[];
}

/**
 * #542 — one of the three axes `triage` merges into a single LLM call.
 * `condition` applies to every property type; `location`/`opportunity` are
 * excluded from a `terreno` (D-095/#398 — unchanged by the merge).
 */
export type TriageAxis = "condition" | "location" | "opportunity";

/**
 * One property's input to the `triage` flow (#542 — condition + location +
 * opportunity merged into one call, replacing three). N-property-capable from
 * day one — `buildTriagePrompt` accepts an ARRAY of these and echoes each
 * `propertyId` back in its output — even though every caller in this PR sends
 * exactly one (Phase 3 of docs/roadmap/llm-batching-plan.md is what packs
 * several properties into one call; the shape is ready for it now so that
 * turning batching on later needs no second prompt-version bump).
 */
export interface TriagePropertyInput {
  /** Echoed back by the model so a response entry can be matched to this property. */
  propertyId: number;
  /** Every live listing of this property, newest-first — same payload the merged flows always read. */
  listings: ListingSnapshot[];
  /** Which of the three axes to answer for this property (a `terreno` requests `["condition"]` only). */
  axes: readonly TriageAxis[];
}

/**
 * FlowVars — per-flow inputs for buildSystemPrompt() / assembleRequest().
 *
 * All fields are optional; each flow reads only the subset relevant to it.
 */
export interface FlowVars {
  // ── occupancy | redflags | extract ─────────────────────────────────────────
  /** The listing under assessment. */
  listing?: ListingSnapshot;
  /**
   * Every live listing of ONE deduplicated property, newest-first.
   *
   * Assessments key on the property, not the advert (#25): a flat listed on
   * three portals is one physical thing with one true occupancy status, and
   * the three descriptions are three witnesses to it. Passing them together
   * lets a portal that says nothing be rescued by a sibling that says
   * "se vende con inquilino" — unreachable when assessing one listing at a
   * time, and the reason this is a list rather than `listing`.
   *
   * Takes precedence over `listing` when both are set.
   */
  listings?: ListingSnapshot[];
  /**
   * Free-text description when the caller has only the text (e.g. re-running
   * an assessment from a stored `listing.description` without re-reading the
   * whole row). Falls back to `listing.description` when omitted.
   */
  description?: string;
  /**
   * Derived (non-listing) input: a bucketed zone-median price-per-m²
   * comparison for this property, e.g. "20-30% por debajo de la mediana de
   * precio/m² ... (10-19 comparables)". Computed by
   * `lib/ai-assessment/price-signal.ts` from `lib/analytics/area-price.ts`
   * (#32), and rendered ONLY by the flows judged to benefit from a
   * below-market-price cue — currently `occupancy` and `redflags` (#184).
   * See that module's doc for why condition/extract don't receive it, why
   * the value is bucketed (cache stability), and why it's undefined rather
   * than a fabricated "priced normally" when area-price.ts itself has
   * nothing defensible to say.
   *
   * Whatever this string is set to here MUST be the exact same string passed
   * as `getOrCompute`'s `extraHashInput` (`lib/ai-assessment/cache.ts`) —
   * that agreement is the entire point of #184 (the mismatch #180 fixed for
   * price, generalised to this new derived field). occupancy.ts/redflags.ts
   * enforce this by computing the string once and passing it to both call
   * sites from the same variable.
   */
  areaPriceSignal?: string;
  /**
   * #396 (Fase 7 of #385) — redflags ONLY: the top-N trending `other`-flag
   * candidate slugs already seen across stored redflags assessments, computed
   * ONCE per batch by the orchestrator (`lib/db/redflag-candidates.ts`) and
   * passed in so `buildRedflagsPrompt` can show the model "what's already been
   * proposed" before it invents a new slug. The builder stays pure — it renders
   * whatever list it is handed and treats an empty/undefined list as the normal
   * cold-start state (no candidates yet). Never a filter; see
   * `RedflagTrendingCandidate`.
   */
  trendingCandidates?: RedflagTrendingCandidate[];
  /**
   * #407 — redflags ONLY: the `candidate_type` slugs a human explicitly
   * dismissed on `/admin/candidatos`, computed ONCE per batch by the
   * orchestrator and passed in so `buildRedflagsPrompt` can tell the model
   * "previously reviewed and rejected — do NOT propose these again". The builder
   * stays pure — it renders whatever list it is handed and treats an
   * empty/undefined list as "nothing dismissed yet". Never a filter; see
   * `DismissedCandidate`.
   */
  dismissedCandidates?: DismissedCandidate[];

  // ── triage ────────────────────────────────────────────────────────────────
  /**
   * #542 — one or more properties for the merged `triage` flow (condition +
   * location + opportunity). Every caller in this PR passes exactly one
   * entry; see `TriagePropertyInput`'s doc for why the shape is an array
   * regardless.
   */
  triageProperties?: TriagePropertyInput[];

  // ── compare ───────────────────────────────────────────────────────────────
  /** Two or more candidates to compare side by side. */
  candidates?: ListingSnapshot[];
  /**
   * The investment thesis to compare against, so "better" is judged against
   * the profile's actual goals rather than a generic notion of quality.
   */
  profileThesis?: string;

  // ── chat ──────────────────────────────────────────────────────────────────
  /** Numeric id of the search profile scoping the conversation, when any. */
  profileId?: number;
  /** Human-readable name of that profile, for grounding the prompt. */
  profileName?: string;
}

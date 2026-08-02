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
  "condition",
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
  "condition",
  "redflags",
  "extract",
  "compare",
]);

export function isLlmFlow(value: string): value is LlmFlow {
  return (LLM_FLOWS as readonly string[]).includes(value);
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
 * FlowVars — per-flow inputs for buildSystemPrompt() / assembleRequest().
 *
 * All fields are optional; each flow reads only the subset relevant to it.
 */
export interface FlowVars {
  // ── occupancy | condition | redflags | extract ────────────────────────────
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

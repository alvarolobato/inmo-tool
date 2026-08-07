/**
 * Location-axis closed vocabulary — the graded beach-proximity enum + badge
 * labels + the heritage-zone label, kept in a LEAF module (no `pg`, no LLM
 * imports).
 *
 * Extracted from `location.ts` for #407 so the redflags candidate-proposal
 * prompt (`lib/llm-context/system-prompt.ts`) can render it as part of the full
 * cross-axis vocabulary without the system-prompt → location → llm →
 * llm-context cycle. Same pattern as `redflag-vocabulary.ts`. `location.ts`
 * re-exports it so existing importers (`lib/candidates.ts`) keep working.
 */

/**
 * Beach-proximity vocabulary (issue #388). A GRADED enum — the two grades the
 * mining found (primera línea vs. vistas al mar) are distinct facts, not one
 * boolean. `none` is the no-signal default. Kept a closed set so the badge
 * vocabulary in `lib/candidates.ts` matches exactly what this flow can emit.
 */
export const BEACH_PROXIMITIES = ["frontline", "sea_view", "near_beach", "none"] as const;

export type BeachProximity = (typeof BEACH_PROXIMITIES)[number];

/**
 * Spanish badge label per beach-proximity grade, for the candidate card (#388).
 * `none` is deliberately absent — a badge on every card carries no information
 * (same rule `CONDITION_LABELS`/`REDFLAG_LABELS` follow). A value not a key
 * here is dropped by the renderer, never shown as raw text.
 */
export const BEACH_PROXIMITY_LABELS: Record<string, string> = {
  frontline: "Primera línea",
  sea_view: "Vistas al mar",
  near_beach: "Cerca playa",
};

/** Spanish badge label for the `heritage_zone` boolean when true (#388). */
export const HERITAGE_ZONE_LABEL = "Casco histórico";

/**
 * Condition-axis closed vocabulary — the renovation-state enum, kept in a LEAF
 * module (no `pg`, no LLM imports).
 *
 * Extracted from `condition.ts` for #407 so the redflags candidate-proposal
 * prompt (`lib/llm-context/system-prompt.ts`) can render it as part of the full
 * cross-axis vocabulary without the system-prompt → condition → llm →
 * llm-context cycle (`condition.ts` pulls in the `pg` client and the LLM entry
 * points). Same pattern `redflag-vocabulary.ts` / `occupancy-vocabulary.ts`
 * follow. `condition.ts` re-exports it so existing importers keep working.
 */

/**
 * Renovation-state vocabulary (issue #26 technical approach #1). Kept to
 * exactly these four — no `buen_estado`/`a_rehabilitar` granularity beyond
 * what the issue specifies, so the badge vocabulary in `lib/candidates.ts`
 * stays a closed set that matches what this flow can actually emit.
 */
export const CONDITION_CATEGORIES = [
  "reformado",
  "a_reformar",
  "obra_nueva",
  "unclear",
] as const;

export type ConditionCategory = (typeof CONDITION_CATEGORIES)[number];

/**
 * Opportunity-axis closed vocabulary — the two named signal concepts + their
 * badge labels, kept in a LEAF module (no `pg`, no LLM imports).
 *
 * Extracted from `opportunity.ts` for #407 so the redflags candidate-proposal
 * prompt (`lib/llm-context/system-prompt.ts`) can render the opportunity
 * concepts (`is_vpo`, `tourist_license`) as part of the full cross-axis
 * vocabulary without the system-prompt → opportunity → llm → llm-context cycle.
 * Same pattern as `redflag-vocabulary.ts`. `opportunity.ts` re-exports it so
 * existing importers (`lib/candidates.ts`) keep working.
 *
 * The opportunity axis is two independent booleans rather than an enum, so its
 * "vocabulary" is the two signal names — modelled here as a small `as const`
 * array so the prompt renders them from a single source of truth (adding a
 * signal makes it appear in the prompt automatically, same guarantee the enum
 * axes have).
 */

/**
 * The named opportunity signals derived from the advert text (#398). Each is a
 * boolean on `OpportunityResult`; this array names them for cross-axis prompt
 * rendering (#407) so the model maps a finding like "es VPO" to `is_vpo`
 * instead of coining a `regimen_vpo` candidate slug.
 */
export const OPPORTUNITY_SIGNALS = ["is_vpo", "tourist_license"] as const;

export type OpportunitySignal = (typeof OPPORTUNITY_SIGNALS)[number];

/** Spanish badge label for the `is_vpo` boolean when true (#398). A material
 *  restriction on what you can buy and at what resale price, so it is a warn-
 *  tone badge in `candidates.ts`, alongside the ownership/transaction caveats. */
export const IS_VPO_LABEL = "VPO";

/** Spanish badge label for the `tourist_license` boolean when true (#398). A
 *  positive, neutral-tone fact (the property can already operate as a VUT). */
export const TOURIST_LICENSE_LABEL = "Licencia turística";

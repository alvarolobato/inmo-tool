/**
 * Occupancy-axis closed vocabularies — the three enums + their derived caveat
 * codes, kept in a LEAF module (no `pg`, no LLM imports).
 *
 * Extracted from `occupancy.ts` for #407: the redflags candidate-proposal
 * prompt (`lib/llm-context/system-prompt.ts`) now renders the FULL cross-axis
 * vocabulary — occupancy included — from these constants, so the model maps a
 * finding to an existing concept instead of coining a duplicate `candidate_type`
 * slug (the owner saw it invent `sin_posesion` for occupancy, `venta_deuda`,
 * `nuda_propiedad`). Importing them straight from `occupancy.ts` would create a
 * cycle (system-prompt → occupancy → llm → llm-context → system-prompt), because
 * `occupancy.ts` transitively pulls in the `pg` client and the LLM entry points.
 * This leaf carries only data, so any module — prompt builder or renderer — can
 * import it safely. Same pattern `redflag-vocabulary.ts` already follows.
 *
 * `occupancy.ts` re-exports everything here, so existing importers keep working
 * unchanged.
 */

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
 * badging. Derived from the three axes in `deriveCaveats()` (occupancy.ts) —
 * never taken from the model — so a badge can never disagree with the verdict
 * it summarises.
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

/**
 * Search profile scope/thesis_params types + Zod validation — client-safe.
 *
 * Split out of lib/db/profiles.ts on purpose: that module imports lib/db-write
 * (the `pg` Postgres client), which pulls in Node built-ins (`fs`, `net`,
 * `tls`, `dns`) that don't exist in a browser bundle. Client components
 * (ProfileForm, app/profiles/page.tsx) need the *types* but must never import
 * the DB access functions — importing from lib/db/profiles instead of this
 * file breaks `next build` with "Module not found: Can't resolve 'fs'" etc.
 * lib/db/profiles.ts re-exports everything here for server-side callers.
 *
 * See issue #1 §5-6 and docs/architecture/data-model.md for the product
 * rationale behind the shape itself.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Scope / thesis_params shape (Zod schemas)
// ---------------------------------------------------------------------------

/**
 * Geography is radius-from-a-geocoded-point for now — a full polygon
 * map-drawing tool is a reasonable later-phase UI enhancement, not required
 * for the MVP filtering need (task 2.3 scope note).
 */
const GeographySchema = z.object({
  type: z.literal("radius"),
  center: z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]),
  radius_km: z.number().positive().max(200),
});

// Must match etl/schema/init.sql's `property.property_type` CHECK constraint
// exactly — a value here that isn't in that CHECK can never match a real row,
// and task 2.4's hard-filter engine would silently return zero results for
// it. See docs/architecture/data-model.md's cross-reference note.
export const PROPERTY_TYPES = [
  "piso",
  "chalet",
  "atico",
  "local",
  "nave",
  "garaje",
  "terreno",
  "edificio",
] as const;

// Single source of truth for the human-readable label of each property
// type — shared by ProfileForm (the scope-editing UI) and CandidateCard
// (the candidate feed, task 2.5) so the two never drift apart.
export const PROPERTY_TYPE_LABELS: Record<(typeof PROPERTY_TYPES)[number], string> = {
  piso: "Piso",
  chalet: "Chalet",
  atico: "Ático",
  local: "Local comercial",
  nave: "Nave industrial",
  garaje: "Garaje",
  terreno: "Terreno",
  edificio: "Edificio completo",
};

const HardExclusionsSchema = z
  .object({
    requires_elevator: z.boolean().optional(),
    excludes_ground_floor: z.boolean().optional(),
    // No min_floor filter: property.floor is free-text (e.g. "bajo", "3º",
    // "3º ext"), not a number, and connectors don't normalize it into an
    // orderable value. A numeric "minimum floor" filter isn't implementable
    // against that column without a floor-parsing layer that doesn't exist
    // yet — dropped rather than shipped as a filter task 2.4 can't honor.
  })
  .strict()
  .default({});

export const ScopeSchema = z
  .object({
    geography: GeographySchema,
    property_types: z.array(z.enum(PROPERTY_TYPES)).min(1),
    // Filters against property.m2_built specifically (not m2_useful) — built
    // area is published far more consistently across sources than useful
    // area, so it's the more reliable filter target. See data-model.md.
    size_min: z.number().nonnegative().optional(),
    size_max: z.number().positive().optional(),
    // Filters against MIN(listing.current_price) across a property's active
    // listings. A deduplicated property (task 2.2) can have 2+ active
    // listings at different prices (sites lag each other); using the lowest
    // is the permissive reading — "could I get this within budget on *some*
    // listing" — not a claim that every listing is in range. See
    // data-model.md for the full rationale and the task 2.4 contract.
    price_min: z.number().nonnegative().optional(),
    price_max: z.number().positive().optional(),
    hard_exclusions: HardExclusionsSchema.optional(),
  })
  .strict()
  .refine(
    (s) => s.price_min === undefined || s.price_max === undefined || s.price_min <= s.price_max,
    { message: "price_min no puede ser mayor que price_max", path: ["price_min"] },
  )
  .refine(
    (s) => s.size_min === undefined || s.size_max === undefined || s.size_min <= s.size_max,
    { message: "size_min no puede ser mayor que size_max", path: ["size_min"] },
  );

export type Scope = z.infer<typeof ScopeSchema>;

/**
 * thesis_params fields are used starting Phase 3 (scoring) / Phase 5
 * (yield/cash-on-cash) but persisted from day one — validated only for type
 * shape, not business rules, since exact usage evolves in later phases.
 */
export const ThesisParamsSchema = z
  .object({
    target_yield_pct: z.number().nonnegative().optional(),
    financing: z
      .object({
        down_payment_pct: z.number().min(0).max(100),
        rate_pct: z.number().nonnegative(),
        term_years: z.number().int().positive(),
        // Task 5.3 (#33), issue #151 tie-in: percentage of GROSS annual rent
        // assumed to go to community fees/IBI/maintenance/vacancy. Optional
        // per-profile override of yield.ts's DEFAULT_OPERATING_COST_PCT —
        // left inside `financing` rather than a new top-level key because
        // ProfileForm already treats this triple as "the investment-maths
        // assumptions block" and #33's Context explicitly says not to invent
        // a second configuration mechanism alongside it.
        operating_cost_pct: z.number().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
    // Issue #151's rent-estimation decision (see PR body / rent-estimate.ts
    // module docstring): #31 (comparable-rental ingestion) is not built and
    // is out of this PR's scope (etl/connectors is owned by other in-flight
    // work), so there is no comparable signal to derive a rent estimate
    // from. Rather than inventing one, this ships a per-profile ASSUMPTION
    // the user states explicitly — an investment thesis's own €/m²/month
    // rent expectation for its target zone — which yield.ts consumes and
    // labels as an assumption, never as a measurement. Unset means "no rent
    // assumption yet": yield.ts returns an explicit no-estimate result
    // rather than fabricating a number.
    rent_assumption: z
      .object({
        eur_per_m2_month: z.number().positive(),
      })
      .strict()
      .optional(),
    // Issue #151: acquisition-cost overrides. Defaults (ITP by comunidad
    // autónoma, notary/registry/gestoría) live in
    // lib/analytics/acquisition-costs.ts's reviewable tables — these fields
    // let a specific profile override any of them (e.g. a buyer circumstance
    // the flat regional table doesn't model, such as a reduced-rate young-
    // buyer ITP). All optional; unset means "use the documented default".
    acquisition_costs: z
      .object({
        itp_pct_override: z.number().min(0).max(100).optional(),
        notary_pct: z.number().nonnegative().optional(),
        registry_pct: z.number().nonnegative().optional(),
        gestoria_eur: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({});

export type ThesisParams = z.infer<typeof ThesisParamsSchema>;

export interface SearchProfileRow {
  id: number;
  name: string;
  scope: Scope;
  thesis_params: ThesisParams;
  archived_at: string | null;
  created_at: string;
}

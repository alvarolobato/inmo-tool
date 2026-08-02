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

export const PROPERTY_TYPES = [
  "piso",
  "chalet",
  "atico",
  "local_comercial",
  "nave_industrial",
  "garaje",
  "terreno",
  "edificio_completo",
] as const;

const HardExclusionsSchema = z
  .object({
    requires_elevator: z.boolean().optional(),
    min_floor: z.number().int().optional(),
    excludes_ground_floor: z.boolean().optional(),
  })
  .strict()
  .default({});

export const ScopeSchema = z
  .object({
    geography: GeographySchema,
    property_types: z.array(z.enum(PROPERTY_TYPES)).min(1),
    price_min: z.number().nonnegative().optional(),
    price_max: z.number().positive().optional(),
    size_min: z.number().nonnegative().optional(),
    size_max: z.number().positive().optional(),
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

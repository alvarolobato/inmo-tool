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
 *
 * `{type: "everywhere"}` (issue #659, D-147) is the STATED sentinel for "no
 * geographic filter" — an unfiltered "novedades" profile that takes small
 * portals wholesale and filters in the list afterwards. This is NOT the same
 * as making `geography` optional: D-013's whole point is that an ABSENT
 * scope field fails loudly, never silently. Everything must still be a value
 * someone explicitly wrote. See buildScopeFunnelStages (scope-query.ts) for
 * what "everywhere" drops (the radius/haversine clause) and what it keeps
 * (the unconditional active-SALE EXISTS, D-016).
 */
const RadiusGeographySchema = z.object({
  type: z.literal("radius"),
  center: z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]),
  radius_km: z.number().positive().max(200),
});

const EverywhereGeographySchema = z.object({ type: z.literal("everywhere") }).strict();

const GeographySchema = z.discriminatedUnion("type", [
  RadiusGeographySchema,
  EverywhereGeographySchema,
]);

export type RadiusGeography = z.infer<typeof RadiusGeographySchema>;
export type EverywhereGeography = z.infer<typeof EverywhereGeographySchema>;
export type Geography = z.infer<typeof GeographySchema>;

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

/**
 * `"all"` (issue #659, D-147) is the STATED sentinel for "every property
 * type" — same rationale as `{type:"everywhere"}` above: a plain
 * `.optional()` here would let `undefined` reach `scope-query.ts`'s
 * `ANY($n::text[])` clause as a NULL array bind, which Postgres evaluates to
 * NO ROWS — the exact silent-zero-matches failure D-013 exists to prevent.
 * `"all"` is a real, explicit value that `buildScopeFunnelStages` reads and
 * responds to by omitting the type condition entirely (never a NULL bind).
 */
const PropertyTypesSchema = z.union([
  z.literal("all"),
  z.array(z.enum(PROPERTY_TYPES)).min(1),
]);

/**
 * Per-profile connector selection (issue #660, part of #658's per-profile
 * connector-selection design). `"all"` (the default — see `effectiveConnectors`
 * below) means unrestricted, matching every source exactly like today; a
 * non-empty list means "only these sources" — the profile stops matching a
 * property whose only active listing comes from an excluded connector.
 *
 * Connector NAMES are validated shape-only here (non-empty strings) — this
 * file is client-safe (no DB import) and can't know the live
 * `connector_registry` roster. Server-side routes (POST /api/profiles, PATCH
 * /api/profiles/[id]) validate each name against the registry after this
 * parse succeeds and 400 on an unknown one (same pattern the
 * connector-filters PUT route uses for its host check) — see
 * lib/db/connectors.ts's `validateConnectorNames`.
 *
 * Deliberately OPTIONAL, not `.default("all")`: unlike `geography`/
 * `property_types` (issue #659/D-147), a genuinely-absent `connectors` has no
 * silent-wrong-answer landmine to guard against — every real consumer reads
 * it through `effectiveConnectors()` below, which treats `undefined` exactly
 * like `"all"` (the same "no restriction" behaviour missing rows already
 * have). Requiring the key would force every one of the ~50 pre-existing
 * `Scope` object literals across the test suite (all predating this issue) to
 * spell out `connectors: "all"` for zero behavioural gain — `property_types`/
 * `geography` never had that retrofit problem because they were required from
 * the schema's original design, before those fixtures existed. New writes
 * (ProfileForm) still state it explicitly, per the issue's intent.
 */
const ConnectorsSchema = z.union([
  z.literal("all"),
  z.array(z.string().min(1)).min(1),
]);

export const ScopeSchema = z
  .object({
    geography: GeographySchema,
    property_types: PropertyTypesSchema,
    connectors: ConnectorsSchema.optional(),
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
 * Normalizes `scope.connectors` to its effective value — `undefined`
 * (missing key, every profile before issue #660) reads exactly like `"all"`.
 * The ONE place every consumer (matching, scopesEqual, the ProfileForm
 * picker, the captura task resolver) should read the field through, so the
 * "absent means unrestricted" rule is stated once, not re-derived per call
 * site.
 */
export function effectiveConnectors(scope: Pick<Scope, "connectors">): "all" | string[] {
  return scope.connectors ?? "all";
}

/**
 * True when `connectorName` is included in a scope's effective connector
 * selection — `"all"` (or an absent field, via {@link effectiveConnectors})
 * always includes everything.
 */
export function scopeIncludesConnector(scope: Pick<Scope, "connectors">, connectorName: string): boolean {
  const selection = effectiveConnectors(scope);
  return selection === "all" || selection.includes(connectorName);
}

/**
 * Human-facing label for a scope's connector selection — "Todas las fuentes"
 * for the unrestricted default, else a comma-joined list of connector names
 * (the picker/overview render the human label; this only needs to look
 * reasonable as a fallback when a display name isn't available).
 */
export function formatConnectorsLabel(scope: Pick<Scope, "connectors">): string {
  const selection = effectiveConnectors(scope);
  if (selection === "all") return "Todas las fuentes";
  return selection.join(", ");
}

/**
 * Human-facing label for a scope's property_types — single source of truth
 * shared by every display consumer (ProfileOverviewRow, the Perfiles
 * degraded-row fallback) so "Todos los tipos" (issue #659's "all" sentinel)
 * never has to be special-cased per call site.
 */
export function formatPropertyTypesLabel(propertyTypes: Scope["property_types"]): string {
  if (propertyTypes === "all") return "Todos los tipos";
  return propertyTypes
    .map((t) => (t in PROPERTY_TYPE_LABELS ? PROPERTY_TYPE_LABELS[t] : t))
    .join(", ");
}

/**
 * Human-facing label for a scope's geography — "Sin filtro geográfico" for
 * the `everywhere` sentinel (issue #659), the existing "radio N km" text
 * otherwise. Single source of truth for the same reason as
 * formatPropertyTypesLabel above.
 */
export function formatGeographyLabel(geography: Geography): string {
  if (geography.type === "everywhere") return "Sin filtro geográfico";
  return `radio ${geography.radius_km} km`;
}

/**
 * Semantic, order-insensitive equality of two scopes — the gate for issue
 * #245's "quick refresh": a profile save enqueues a crawl and re-materializes
 * ONLY when the crawl-relevant scope actually changed, never on a pure rename
 * (or a thesis_params-only edit, which isn't part of scope at all).
 *
 * Deliberately NOT a generic deep-equal / JSON.stringify comparison, because
 * two forms carry structural noise that isn't a real scope change:
 *   - `property_types` is a SET the form rebuilds by toggling — reordering the
 *     checkboxes must not count as a change.
 *   - a `hard_exclusions` boolean that is absent vs. explicitly `false` is the
 *     same "no exclusion" — toggling a filter on and back off must not count.
 *   - an absent numeric bound and `undefined` are the same "no bound".
 * A JSON string compare would report all three as changes and enqueue a
 * redundant crawl. `center` stays order-sensitive (it's an ordered
 * [lat, lng] tuple, not a set).
 *
 * Pure and client-safe (no `pg` import) so the PATCH route and its unit tests
 * can both use it.
 */
/** How a profile-refresh crawl enqueue resolved (issue #245). Client-safe. */
export type CrawlEnqueueStatus = "enqueued" | "already_pending" | "error";

/**
 * The `refresh` field POST /api/profiles and a scope-changing PATCH
 * /api/profiles/[id] attach to their response (issue #245). Client-safe (no
 * `pg`) so both the server helper (lib/filtering/profile-refresh.ts) and the
 * client page that renders the "buscando datos nuevos…" indicator share one
 * shape.
 */
export interface ProfileRefreshResult {
  /** True when the profile was re-materialized against the current pool. */
  materialized: boolean;
  /** Ad-hoc sweep enqueue outcome; `triggerId` is pollable via GET /api/etl/run?id=. */
  crawl: { status: CrawlEnqueueStatus; triggerId: number | null };
}

export function scopesEqual(a: Scope, b: Scope): boolean {
  // Geography — a radius<->everywhere transition IS a scope change (issue
  // #659): it changes which properties can match (drops the haversine
  // clause, plus the un-geocoded-property recall gain), so D-040's quick
  // refresh must fire on it exactly like a real radius/center edit.
  if (a.geography.type !== b.geography.type) return false;
  if (a.geography.type === "radius" && b.geography.type === "radius") {
    if (a.geography.center[0] !== b.geography.center[0]) return false;
    if (a.geography.center[1] !== b.geography.center[1]) return false;
    if (a.geography.radius_km !== b.geography.radius_km) return false;
  }
  // Both "everywhere": nothing else to compare, equal.

  // property_types — the "all" sentinel is compared as a first-class value,
  // never unwrapped into (or confused with) an explicit list, even one that
  // happens to name every type: "all" and a fully-enumerated list are
  // different STATED scopes (one tracks future new types automatically, the
  // other doesn't), so switching between them is a real scope change too.
  if (a.property_types === "all" || b.property_types === "all") {
    if (a.property_types !== b.property_types) return false;
  } else {
    // Compared as a set (order carries no meaning).
    const at = [...a.property_types].sort();
    const bt = [...b.property_types].sort();
    if (at.length !== bt.length) return false;
    for (let i = 0; i < at.length; i++) {
      if (at[i] !== bt[i]) return false;
    }
  }

  // connectors (issue #660) — compared through effectiveConnectors() so an
  // absent field and an explicit "all" (semantically identical, per the
  // helper's own docstring) never register as a scope change. "all" vs. a
  // real list, and two different lists, DO count as a change: narrowing or
  // widening which sources a profile matches changes the matched set exactly
  // like a property_types edit, so D-040's quick refresh must fire.
  const aConn = effectiveConnectors(a);
  const bConn = effectiveConnectors(b);
  if (aConn === "all" || bConn === "all") {
    if (aConn !== bConn) return false;
  } else {
    const ac = [...aConn].sort();
    const bc = [...bConn].sort();
    if (ac.length !== bc.length) return false;
    for (let i = 0; i < ac.length; i++) {
      if (ac[i] !== bc[i]) return false;
    }
  }

  // Numeric bounds — an absent bound must equal an absent bound.
  if (a.price_min !== b.price_min) return false;
  if (a.price_max !== b.price_max) return false;
  if (a.size_min !== b.size_min) return false;
  if (a.size_max !== b.size_max) return false;

  // hard_exclusions — a missing key and an explicit `false` are both "no
  // exclusion", so normalize to false before comparing.
  const aeh = a.hard_exclusions ?? {};
  const beh = b.hard_exclusions ?? {};
  if ((aeh.requires_elevator ?? false) !== (beh.requires_elevator ?? false)) return false;
  if ((aeh.excludes_ground_floor ?? false) !== (beh.excludes_ground_floor ?? false)) return false;

  return true;
}

/**
 * thesis_params fields are used starting Phase 3 (scoring) / Phase 5
 * (yield/cash-on-cash) but persisted from day one — validated only for type
 * shape, not business rules, since exact usage evolves in later phases.
 */
/**
 * Investment thesis kind (issue #45 — the documented `thesis_type` marker
 * convention task 2.3 left open for later phases to define). A buy-to-flip
 * profile (`"flip"`) is the architect-investor's refurbish-and-resell play;
 * `"rent"` (or unset — the historical default) is the buy-to-rent play the
 * yield/cash-on-cash metrics already serve.
 *
 * Gates the renovation-cost / ARV / flip-margin section on the property detail
 * page: it renders ONLY for `thesis_type === "flip"` (issue #45 EC-3). Unset is
 * treated as `"rent"` so every pre-#45 profile keeps its exact current
 * behaviour — no flip section, no schema break.
 */
export const THESIS_TYPES = ["rent", "flip"] as const;
export type ThesisType = (typeof THESIS_TYPES)[number];

export const ThesisParamsSchema = z
  .object({
    thesis_type: z.enum(THESIS_TYPES).optional(),
    target_yield_pct: z.number().nonnegative().optional(),
    financing: z
      .object({
        // Each field is independently optional (NOT the "all-or-nothing
        // triple" this schema originally required) — an Opus review found
        // that requiring all three meant ProfileForm had to silently
        // synthesize rate_pct/term_years defaults the instant a user typed
        // only a down payment, and yield.ts's old single
        // `financing_is_default` flag then reported those silently-filled
        // values as "user-set" (see yield.ts's per-field
        // `*_is_default` flags, which depend on each field being
        // independently undefined-able here to mean anything).
        down_payment_pct: z.number().min(0).max(100).optional(),
        rate_pct: z.number().nonnegative().optional(),
        term_years: z.number().int().positive().optional(),
        // Task 5.3 (#33), issue #151 tie-in: percentage of GROSS annual rent
        // assumed to go to community fees/IBI/maintenance/vacancy when
        // NEITHER actual IBI nor community fee is known. Optional
        // per-profile override of yield.ts's DEFAULT_OPERATING_COST_PCT —
        // left inside `financing` rather than a new top-level key because
        // ProfileForm already treats this triple as "the investment-maths
        // assumptions block" and #33's Context explicitly says not to invent
        // a second configuration mechanism alongside it.
        operating_cost_pct: z.number().min(0).max(100).optional(),
        // Issue #151 (Opus review revision): percentage of GROSS annual
        // rent assumed for maintenance + vacancy ONLY, applied on top of
        // actual IBI/community-fee figures whenever at least one is known
        // (see yield.ts's DEFAULT_MAINTENANCE_VACANCY_PCT docstring for the
        // full "additive, not a full replacement" rationale).
        maintenance_vacancy_pct: z.number().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
    // Issue #151's rent-estimation decision (see rent-estimate.ts's module
    // docstring, D-014): an investment thesis's own €/m²/month rent
    // expectation for its target zone, stated explicitly by the user.
    // Since issue #31, `rent-estimate.ts` also computes a measured
    // comparable-rent estimate from ingested rental listings — but this
    // field, when set, remains PRIMARY (never silently overridden by the
    // measured figure; see D-014's precedence rule) and yield.ts still
    // labels it as an assumption, never as a measurement. Unset means
    // "no rent assumption": yield.ts falls back to the measured
    // comparable estimate when one is usable, or an explicit no-estimate
    // result when neither is available — never a fabricated number.
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
  /** Issue #191: NULL means "never materialized" — distinct from "materialized, matched zero". Set by materializeProfile on every run. */
  last_materialized_at: string | null;
  /** Issue #191: NULL means "never opened /profiles/[id]". Set best-effort by GET /api/profiles/[id]. */
  last_viewed_at: string | null;
}

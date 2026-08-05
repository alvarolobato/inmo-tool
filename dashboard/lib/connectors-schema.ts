import { z } from "zod";

/**
 * Client-safe types and validation for connector management (issue #100).
 *
 * Deliberately separate from `lib/db/connectors.ts`, which imports the `pg`
 * client: a client component importing types from that module pulls Node
 * built-ins (`fs`/`net`/`tls`/`dns`) into the browser bundle and breaks
 * `next build` outright — a real bug this project already shipped once
 * (task 2.3, PR #56) and fixed the same way. Nothing in this file may
 * import from `lib/db/*`.
 */

/**
 * Geography override shape. Intentionally identical to a search profile's
 * `scope.geography` radius shape (`lib/profiles-schema.ts`) — the ETL's
 * `_scopes_for_connector` parses both with the same expectations, and the
 * UI reuses the same `LocationPicker` for both. That includes the 200 km
 * cap: it was 500 here while profiles capped at 200, despite this comment
 * claiming they matched (issue #100 review). The ETL enforces no upper
 * bound at all, so this is purely a write-side sanity limit, and there is
 * no reason for the two surfaces to disagree about it.
 */
export const GeographyOverrideSchema = z.object({
  center: z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]),
  radius_km: z.number().positive().max(200),
});

export type GeographyOverride = z.infer<typeof GeographyOverrideSchema>;

/**
 * Native site filters. Only keys a connector actually declares in its
 * `supported_filters` are ever sent — the API cross-checks against the
 * registry, so a filter that isn't live-verified for a site can't be
 * persisted even by a hand-crafted request.
 *
 * `rooms` is Fotocasa's `/N-habitaciones/` URL segment: an EXACT-match room
 * count, not a minimum (live-verified in issue #99 — every result on a
 * `2-habitaciones` page had exactly 2 rooms, none had 3+). Named `rooms`
 * rather than `min_rooms` for precisely that reason.
 */
export const ConnectorFiltersSchema = z.object({
  rooms: z.number().int().min(1).max(20).optional(),
});

export type ConnectorFilters = z.infer<typeof ConnectorFiltersSchema>;

/**
 * Freshness-cadence defaults (issue #295, D-050). These mirror the ETL's
 * `etl.default_freshness_interval_hours` (24h) and
 * `etl.freshness_cycle_stuck_after_hours` (168h / 7d) from config/schema.yaml.
 * They are the dashboard-side copy of the same numbers: the ETL is the
 * authority that acts on them, this side only resolves the effective interval
 * for display and derives the observability state. Kept in this client-safe
 * module (no `pg` import) so both the API layer and UI can reuse them.
 *
 * The 24h default deliberately coincides with the freshness pill's
 * `FRESHNESS_STALE_THRESHOLD_HOURS` (issue #241) — a connector at the default
 * cadence and the "data is stale after a day" pill agree on the same horizon.
 */
export const DEFAULT_FRESHNESS_INTERVAL_HOURS = 24;
export const DEFAULT_FRESHNESS_CYCLE_STUCK_AFTER_HOURS = 168;
/**
 * Write-side sanity cap on a per-connector override — 90 days. The ETL
 * enforces no upper bound (any positive int is honoured), so this is purely a
 * "nobody meant to type 100000" guard, the same posture as the geography
 * radius cap above.
 */
export const MAX_FRESHNESS_INTERVAL_HOURS = 24 * 90;

/** PATCH body. Every field optional — a request may change only one thing. */
export const ConnectorConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Issue #295 (D-050): the per-connector freshness cadence override, in
    // hours. `null` explicitly clears the override (back to the global
    // default); omitting the key leaves the stored value untouched — the same
    // clear-vs-leave-alone distinction geography_override draws, so nullable
    // rather than merely optional. Unlike geography_override/filters, this is a
    // framework-level scheduling knob VALID EVEN FOR capture-only connectors
    // (supports_discovery=false): it doubles as the staleness window #289's
    // manual-capture UI reads, so the PATCH route must NOT reject it for them.
    freshness_interval_hours: z
      .number()
      .int()
      .positive()
      .max(MAX_FRESHNESS_INTERVAL_HOURS)
      .nullable()
      .optional(),
    // Issue #263: capture PROCESSING toggle, independent of the crawl
    // `enabled` flag above. A capture-only portal (Idealista, Aliseda) keeps
    // `enabled=false` so its doomed automated crawl never runs, but must
    // still process extension captures — that is what this controls. Enabling
    // capture never arms the crawl.
    capture_enabled: z.boolean().optional(),
    // `null` explicitly clears an override (back to profile-derived scope);
    // omitting the key leaves whatever is stored untouched. These are
    // genuinely different operations, so the field is nullable rather than
    // just optional.
    geography_override: GeographyOverrideSchema.nullable().optional(),
    filters: ConnectorFiltersSchema.optional(),
  })
  .strict();

export type ConnectorConfigPatch = z.infer<typeof ConnectorConfigPatchSchema>;

/** One active search profile contributing to the profile-derived default scope. */
export interface DerivedScopeSource {
  profile_id: number;
  profile_name: string;
  center: [number, number];
  radius_km: number;
}

/**
 * Observability state of a connector's freshness cadence (issue #295, D-050),
 * derived — never stored — from `connector_freshness_state` + the effective
 * interval:
 *   - `"fresh"`      — idle (no cycle) and last_fresh_at is inside the interval.
 *   - `"refreshing"` — a cycle is in progress and not yet past the stuck horizon.
 *   - `"stuck"`      — a cycle has been in progress longer than the stuck horizon
 *                      (never force-completed; reads as "taking unusually long").
 *   - `"due"`        — idle and either never fresh or the interval has elapsed;
 *                      the next scheduler tick will start a cycle.
 */
export type ConnectorFreshnessKind = "fresh" | "refreshing" | "stuck" | "due";

/** The freshness-cadence snapshot the connectors page renders per connector. */
export interface ConnectorFreshnessState {
  /** Derived state (see ConnectorFreshnessKind). */
  kind: ConnectorFreshnessKind;
  /** The per-connector override in hours, or null when using the global default. */
  intervalHours: number | null;
  /** The resolved interval actually in effect (override ?? global default). */
  effectiveIntervalHours: number;
  /** When the last full cycle completed, ISO — null when never fresh. */
  lastFreshAt: string | null;
  /** When the in-progress cycle started, ISO — null when idle. */
  cycleStartedAt: string | null;
  /** How many scopes this cycle set out to cover (snapshot at cycle start). */
  targetScopeCount: number | null;
  /** How many of those have been (re)discovered since the cycle started. */
  coveredScopeCount: number | null;
  /** The stuck horizon in hours, so the UI can phrase "más de Nh refrescando". */
  stuckAfterHours: number;
}

/** Most recent run outcome for a connector, if it has ever run. */
export interface ConnectorLastRun {
  run_id: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  discovered_count: number;
  fetched_count: number;
  error_count: number;
  error_msg: string | null;
}

/**
 * One connector as the management page sees it: what it is (registry), how
 * it's configured (config), what that resolves to right now (effective),
 * and how it last behaved (lastRun).
 */
export interface ConnectorView {
  name: string;
  registered: boolean;
  rate_limit_per_minute: number | null;
  discovers_full_inventory: boolean | null;
  supports_discovery: boolean;
  supported_filters: string[];

  /** True when no `connector_config` row exists — running on pure defaults. */
  usingDefaults: boolean;
  enabled: boolean;
  /**
   * Whether extension-capture PROCESSING is enabled for this connector
   * (issue #263) — independent of `enabled`, which only governs the automated
   * crawl. A capture-only portal runs with `enabled=false` (crawl off) and
   * `capture_enabled=true` (captures still processed). Defaults `true` when no
   * config row exists.
   */
  capture_enabled: boolean;
  geography_override: GeographyOverride | null;
  filters: ConnectorFilters;

  /**
   * Where this connector's scope actually comes from on the next run.
   * `"override"` — the explicit `geography_override` below.
   * `"profiles"` — the union of active search profiles (issue #71's default).
   * `"none"`     — nothing to run: no override and no active profile.
   * `"capture-only"` — connector never discovers at all (Idealista, #75).
   */
  scopeSource: "override" | "profiles" | "none" | "capture-only";
  derivedFrom: DerivedScopeSource[];

  /**
   * Freshness cadence state (issue #295, D-050). Present for every connector,
   * including capture-only ones — the interval is a valid knob for them too
   * (it's the staleness window #289's manual-capture UI reads).
   */
  freshness: ConnectorFreshnessState;

  lastRun: ConnectorLastRun | null;
}

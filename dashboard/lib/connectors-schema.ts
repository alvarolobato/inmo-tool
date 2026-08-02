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

/** PATCH body. Every field optional — a request may change only one thing. */
export const ConnectorConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
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

  lastRun: ConnectorLastRun | null;
}

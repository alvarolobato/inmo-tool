/**
 * Connector management persistence (issue #100) — server-only (imports
 * lib/db-write, the `pg` client). Never import this from a client
 * component; use lib/connectors-schema.ts for types/validation instead.
 */

import { sql } from "@/lib/db-write";
import {
  DEFAULT_FRESHNESS_CYCLE_STUCK_AFTER_HOURS,
  DEFAULT_FRESHNESS_INTERVAL_HOURS,
  type ConnectorConfigPatch,
  type ConnectorFilters,
  type ConnectorFreshnessState,
  type ConnectorLastRun,
  type ConnectorView,
  type DerivedScopeSource,
  type GeographyOverride,
} from "@/lib/connectors-schema";
import { isCapturePortal } from "@/lib/worklist";
import { resolveStalenessDays, type StalenessConfig } from "@/lib/captura-tasks";
import { getStalenessConfig } from "@/lib/captura-staleness-config";

/**
 * Global freshness-cadence knobs, resolved dashboard-side (issue #295, D-050).
 *
 * The ETL is the authority — it reads `etl.default_freshness_interval_hours` /
 * `etl.freshness_cycle_stuck_after_hours` from config/schema.yaml and is what
 * actually starts/skips cycles. This side only needs the same numbers to
 * DISPLAY the resolved interval and DERIVE the observability state, so it reads
 * an env override (parallel to the pill's `FRESHNESS_STALE_THRESHOLD_HOURS`,
 * #241) and falls back to the shared default constant. No dual source of truth
 * for the *decision* — that stays in Python; this is purely presentation.
 */
function envHoursOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultFreshnessIntervalHours(): number {
  return envHoursOrDefault(
    "FRESHNESS_DEFAULT_INTERVAL_HOURS",
    DEFAULT_FRESHNESS_INTERVAL_HOURS,
  );
}

export function freshnessCycleStuckAfterHours(): number {
  return envHoursOrDefault(
    "FRESHNESS_CYCLE_STUCK_AFTER_HOURS",
    DEFAULT_FRESHNESS_CYCLE_STUCK_AFTER_HOURS,
  );
}

/**
 * Resolve a stored `freshness_interval_hours` override to an effective
 * interval, mirroring the ETL's `_resolve_freshness_interval_hours`: a NULL,
 * non-positive, or non-integral value means "use the global default", never
 * "disable tracking".
 */
export function resolveFreshnessInterval(
  overrideRaw: unknown,
  defaultHours: number,
): { intervalHours: number | null; effectiveIntervalHours: number } {
  const override = coerceFiniteNumber(overrideRaw);
  if (override === null || override <= 0 || !Number.isInteger(override)) {
    return { intervalHours: null, effectiveIntervalHours: defaultHours };
  }
  return { intervalHours: override, effectiveIntervalHours: override };
}

/**
 * Derive the observability state (issue #295, D-050) from the raw
 * `connector_freshness_state` row + the effective interval. Binary and
 * timestamp-driven, exactly like the ETL's `_finalize_connector_freshness_cycle`
 * (there is deliberately no stored `stuck` column — the age of cycle_started_at
 * IS the signal):
 *   - a cycle in progress → "refreshing", or "stuck" once past the horizon;
 *   - idle → "fresh" while inside the interval, else "due" (incl. never-fresh).
 */
export function deriveFreshnessState(params: {
  intervalHoursOverrideRaw: unknown;
  lastFreshAt: Date | string | null;
  cycleStartedAt: Date | string | null;
  targetScopeCount: number | null;
  coveredScopeCount: number | null;
  defaultIntervalHours: number;
  stuckAfterHours: number;
  nowMs: number;
}): ConnectorFreshnessState {
  const { intervalHours, effectiveIntervalHours } = resolveFreshnessInterval(
    params.intervalHoursOverrideRaw,
    params.defaultIntervalHours,
  );
  const lastFreshAt = toIso(params.lastFreshAt);
  const cycleStartedAt = toIso(params.cycleStartedAt);

  let kind: ConnectorFreshnessState["kind"];
  if (cycleStartedAt !== null) {
    const ageMs = params.nowMs - new Date(cycleStartedAt).getTime();
    kind = ageMs > params.stuckAfterHours * 3600 * 1000 ? "stuck" : "refreshing";
  } else if (lastFreshAt === null) {
    kind = "due";
  } else {
    const ageMs = params.nowMs - new Date(lastFreshAt).getTime();
    kind = ageMs >= effectiveIntervalHours * 3600 * 1000 ? "due" : "fresh";
  }

  return {
    kind,
    intervalHours,
    effectiveIntervalHours,
    lastFreshAt,
    cycleStartedAt,
    targetScopeCount: params.targetScopeCount,
    coveredScopeCount: params.coveredScopeCount,
    stuckAfterHours: params.stuckAfterHours,
  };
}

/**
 * Issue #586/D-125 — is `connectorName` a CAPTURE-ONLY portal for freshness
 * purposes: `supportsDiscovery=false` (discover() never runs for it) AND it
 * is on the #454 extension-capturable allow-list (`isCapturePortal`). The
 * second half matters: a hypothetical future non-discovery connector that
 * ISN'T extension-capturable would otherwise be pulled into the capture
 * branch below with no `extension_capture` rows ever possible for it —
 * permanently "due" with no way to ever clear (Opus review, PR #590).
 */
export function isCaptureOnlyForFreshness(
  connectorName: string,
  supportsDiscovery: boolean,
): boolean {
  // Strict `=== false`, not `!supportsDiscovery`: the column is NOT NULL
  // DEFAULT true in the schema, so a real row is always a real boolean, but
  // a test double / partial row that omits the field must NOT silently read
  // as capture-only (that inverted default was caught by review on PR #590 —
  // it happened to be masked in existing mocks by capture_enabled also being
  // absent, not actually correct).
  return supportsDiscovery === false && isCapturePortal(connectorName);
}

/**
 * Resolve one connector's freshness STATE — the ONE definition shared by
 * `getConnectorFreshness()` (dashboard/lib/db/freshness.ts, drives the
 * TopBar dot) and `listConnectors()` below (drives the /admin/fuentes
 * pill), so the two surfaces cannot structurally diverge on what "due"
 * means (issue #586, D-125). Before this extraction, `listConnectors()`
 * read `connector_freshness_state` alone for every connector including
 * capture-only ones — a table with NO rows at all for a portal whose crawl
 * never runs — so the pill read "obsoleto, sin ciclo iniciado" forever for
 * every capture-only portal while the TopBar dot correctly read some of
 * them fresh (Opus review, PR #590). Both call sites now call this.
 *
 * A crawl connector is fed its freshness CYCLE (`connector_freshness_state`,
 * issue #295/D-050). A capture-only portal (see `isCaptureOnlyForFreshness`)
 * has no cycle — discover() never runs for it — so it is instead fed its
 * latest 'done' `extension_capture` timestamp as `lastFreshAt`, no cycle
 * (`cycleStartedAt` always null, so it can only ever resolve to "fresh" or
 * "due"), and a different default window: the Captura staleness config
 * (issue #289, `resolveStalenessDays`) rather than the crawl default.
 */
export function resolveConnectorFreshnessState(params: {
  connectorName: string;
  supportsDiscovery: boolean;
  freshnessIntervalHoursRaw: unknown;
  lastFreshAt: Date | string | null;
  cycleStartedAt: Date | string | null;
  targetScopeCount: number | null;
  coveredScopeCount: number | null;
  lastCaptureDoneAt: Date | string | null;
  defaultIntervalHours: number;
  stalenessConfig: StalenessConfig;
  stuckAfterHours: number;
  nowMs: number;
}): ConnectorFreshnessState {
  if (isCaptureOnlyForFreshness(params.connectorName, params.supportsDiscovery)) {
    return deriveFreshnessState({
      intervalHoursOverrideRaw: params.freshnessIntervalHoursRaw,
      lastFreshAt: params.lastCaptureDoneAt,
      cycleStartedAt: null,
      targetScopeCount: null,
      coveredScopeCount: null,
      defaultIntervalHours:
        resolveStalenessDays(params.connectorName, params.stalenessConfig) * 24,
      stuckAfterHours: params.stuckAfterHours,
      nowMs: params.nowMs,
    });
  }
  return deriveFreshnessState({
    intervalHoursOverrideRaw: params.freshnessIntervalHoursRaw,
    lastFreshAt: params.lastFreshAt,
    cycleStartedAt: params.cycleStartedAt,
    targetScopeCount: params.targetScopeCount,
    coveredScopeCount: params.coveredScopeCount,
    defaultIntervalHours: params.defaultIntervalHours,
    stuckAfterHours: params.stuckAfterHours,
    nowMs: params.nowMs,
  });
}

interface RegistryRow {
  connector_name: string;
  registered: boolean;
  rate_limit_per_minute: number | string | null;
  discovers_full_inventory: boolean | null;
  supports_discovery: boolean;
  supported_filters: unknown;
  override_host_suffix: string | null;
  supports_search_override: boolean | null;
  search_url_grammar: unknown;
  enabled: boolean | null;
  capture_enabled: boolean | null;
  geography_override: unknown;
  filters: unknown;
  has_config: boolean;
  // Issue #295 (D-050): freshness-cadence override + live cycle state.
  freshness_interval_hours: number | string | null;
  last_fresh_at: Date | string | null;
  cycle_started_at: Date | string | null;
  cycle_target_scope_count: number | string | null;
  // How many target scopes have been (re)discovered since the current cycle
  // started — 0 when no cycle is in progress. See the LATERAL below.
  covered_scope_count: number | string | null;
  // Issue #586: latest 'done' extension_capture for this connector — the
  // capture-only portals' equivalent of a successful crawl cycle.
  last_capture_done_at: Date | string | null;
}

interface LastRunRow {
  connector_name: string;
  // run_id is BIGINT (connector_run_results.run_id) — arrives as a real JS
  // number via the driver-level int8 type parser (db-shared.ts, #155).
  run_id: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  // discovered_count/fetched_count/error_count are plain INTEGER, not
  // BIGINT — pg has always returned these as numbers.
  discovered_count: number;
  fetched_count: number;
  error_count: number;
  error_msg: string | null;
}

interface ProfileScopeRow {
  // search_profile.id is BIGSERIAL — see LastRunRow.run_id above.
  id: number;
  name: string;
  scope: unknown;
}

/**
 * `rate_limit_per_minute` (connector_registry) is a plain INTEGER, so this
 * only exists to normalise the occasional string-typed value in a query
 * result shape shared across a couple of call sites — not a BIGINT/int8
 * concern (see #155: those are handled at the driver level, not here).
 */
function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

/**
 * `null` unless `value` is a real finite number or a string Python's
 * `float()` would accept. The ETL coerces stored JSON with `float()`/
 * `int()`, so a value stored as `"40.4"` is genuinely live there; reading
 * it back as "not configured" here would be the UI lying in the opposite
 * direction from the malformed case (issue #100 review).
 */
/** TIMESTAMPTZ → ISO string. pg hands back a Date; tolerate a string too. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read-side parsing of a stored `geography_override`.
 *
 * Deliberately NOT `GeographyOverrideSchema` (that stays the strict
 * *write*-side contract for the PATCH route — what a new override is
 * allowed to be). Reading has to answer a different question: what will
 * the ETL actually do with the row that is already stored? So this mirrors
 * `etl/orchestrator.py::_scopes_for_connector`'s real tolerance —
 * `float()`-coercible center elements, any positive radius (the ETL
 * enforces no upper bound) — and returns `null` only where the ETL itself
 * would fall back to the profile-derived scope.
 */
function parseGeographyOverride(raw: unknown): GeographyOverride | null {
  // A malformed stored override is shown as "no override" rather than
  // throwing: the ETL already treats a malformed row as fall-back-to-
  // profile-scope (etl/orchestrator.py `_scopes_for_connector`), so the UI
  // must not claim an override is in effect when the ETL will ignore it.
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const center = (raw as { center?: unknown }).center;
  const radiusRaw = (raw as { radius_km?: unknown }).radius_km;
  if (!Array.isArray(center) || center.length !== 2) return null;
  // The ETL requires radius_km to already be a non-boolean number before
  // it will call float() on it — a stored string radius really is ignored
  // there, so it must read as "no override" here too.
  if (typeof radiusRaw !== "number" || !Number.isFinite(radiusRaw)) return null;
  if (radiusRaw <= 0) return null;
  const lat = coerceFiniteNumber(center[0]);
  const lon = coerceFiniteNumber(center[1]);
  if (lat === null || lon === null) return null;
  return { center: [lat, lon], radius_km: radiusRaw };
}

/**
 * Read-side parsing of stored `filters`, matching the ETL's `int()`
 * coercion (so a `rooms` stored as `"3"` reads as the live filter it
 * actually is). `ConnectorFiltersSchema` remains the strict write-side
 * contract.
 */
function parseFilters(raw: unknown): ConnectorFilters {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return {};
  const roomsRaw = (raw as { rooms?: unknown }).rooms;
  if (roomsRaw === undefined || roomsRaw === null) return {};
  if (typeof roomsRaw === "boolean") return {};
  const rooms = coerceFiniteNumber(roomsRaw);
  // int() truncates rather than rounding, and rejects a non-integral
  // string like "3.5" outright — mirror both.
  if (rooms === null) return {};
  if (typeof roomsRaw === "string" && !Number.isInteger(rooms)) return {};
  return { rooms: Math.trunc(rooms) };
}

function parseSupportedFilters(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Every active search profile's geography — the union the ETL derives a
 * connector's default scope from when it has no explicit override (issue
 * #71). Surfaced per connector so an operator can see *what* "derived from
 * profiles" actually resolves to, which is precisely the visibility gap
 * that made ingestion feel unpredictable (issue #96).
 *
 * Note this deliberately does NOT replicate the ETL's nearest-city
 * resolution (`etl/connectors/geography.py`): that's site-specific Python,
 * and duplicating it here would create a second source of truth that
 * silently drifts. This shows the *inputs* to that resolution, honestly
 * labelled as such, rather than guessing at its output.
 */
async function fetchDerivedScopeSources(): Promise<DerivedScopeSource[]> {
  const rows = await sql<ProfileScopeRow>(
    `SELECT id, name, scope
       FROM search_profile
      WHERE archived_at IS NULL
      ORDER BY id`,
  );

  const sources: DerivedScopeSource[] = [];
  for (const row of rows) {
    const scope = row.scope;
    if (typeof scope !== "object" || scope === null) continue;
    const geography = (scope as { geography?: unknown }).geography;
    if (typeof geography !== "object" || geography === null) continue;
    // The ETL requires `type === "radius"` before it will derive a scope
    // from a profile (`_active_profile_scopes`). Without this same check,
    // a profile with some other geography shape was listed here as a live
    // contributing source while the ETL silently skipped it — the UI
    // claiming an ingestion input that does not exist (issue #100 review).
    if ((geography as { type?: unknown }).type !== "radius") continue;
    const center = (geography as { center?: unknown }).center;
    const radiusKm = (geography as { radius_km?: unknown }).radius_km;
    // Tolerance deliberately mirrors the ETL's, which coerces each center
    // element with float() (so numeric strings pass) but requires
    // radius_km to already be a real, non-boolean number.
    const lat = coerceFiniteNumber(Array.isArray(center) ? center[0] : undefined);
    const lon = coerceFiniteNumber(Array.isArray(center) ? center[1] : undefined);
    if (
      !Array.isArray(center) ||
      center.length !== 2 ||
      lat === null ||
      lon === null ||
      typeof radiusKm !== "number" ||
      !Number.isFinite(radiusKm)
    ) {
      // Same posture as the ETL: skip a malformed profile rather than
      // failing the whole listing.
      continue;
    }
    sources.push({
      profile_id: row.id,
      profile_name: row.name,
      center: [lat, lon],
      radius_km: radiusKm,
    });
  }
  return sources;
}

async function fetchLastRuns(): Promise<Map<string, ConnectorLastRun>> {
  // DISTINCT ON gives the most recent result row per connector in one pass.
  const rows = await sql<LastRunRow>(
    `SELECT DISTINCT ON (r.connector_name)
            r.connector_name,
            r.run_id,
            r.status,
            r.started_at,
            r.finished_at,
            r.discovered_count,
            r.fetched_count,
            r.error_count,
            r.error_msg
       FROM connector_run_results r
       ORDER BY r.connector_name, r.run_id DESC`,
  );

  const byName = new Map<string, ConnectorLastRun>();
  for (const row of rows) {
    byName.set(row.connector_name, {
      run_id: row.run_id,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      discovered_count: row.discovered_count,
      fetched_count: row.fetched_count,
      error_count: row.error_count,
      error_msg: row.error_msg,
    });
  }
  return byName;
}

/**
 * Every registered connector, joined against its config (defaults applied
 * when no row exists), the profile-derived scope inputs, and its last run.
 */
export async function listConnectors(): Promise<ConnectorView[]> {
  const [registryRows, lastRuns, derivedFrom] = await Promise.all([
    // LEFT JOIN, not INNER: a connector that has never been configured must
    // still appear — that's the default state of this table, and the
    // "everything is off until I configure it" flow depends on seeing them.
    sql<RegistryRow>(
      `SELECT g.connector_name,
              g.registered,
              g.rate_limit_per_minute,
              g.discovers_full_inventory,
              g.supports_discovery,
              g.supported_filters,
              g.override_host_suffix,
              g.supports_search_override,
              g.search_url_grammar,
              c.enabled,
              c.capture_enabled,
              c.geography_override,
              c.filters,
              c.freshness_interval_hours,
              (c.connector_name IS NOT NULL) AS has_config,
              f.last_fresh_at,
              f.cycle_started_at,
              f.cycle_target_scope_count,
              -- Scopes (re)discovered since the current cycle started — the "N"
              -- in "refrescando N/M". 0 when no cycle is in progress (the AND
              -- short-circuits on a NULL cycle_started_at). Read live from
              -- connector_scope_state (D-030), exactly as the ETL computes it.
              COALESCE(cov.covered_count, 0) AS covered_scope_count,
              -- Issue #586: same 'done' extension_capture aggregate freshness.ts
              -- reads for the TopBar dot — SAME join, so this page's pill and
              -- the dot can never structurally disagree on a capture-only
              -- portal's freshness (D-125).
              cap.last_capture_done_at
         FROM connector_registry g
         LEFT JOIN connector_config c ON c.connector_name = g.connector_name
         LEFT JOIN connector_freshness_state f ON f.connector_name = g.connector_name
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS covered_count
             FROM connector_scope_state s
            WHERE s.connector_name = g.connector_name
              AND f.cycle_started_at IS NOT NULL
              AND s.last_discovered_at >= f.cycle_started_at
         ) cov ON true
         LEFT JOIN (
           SELECT connector_name, MAX(created_at) AS last_capture_done_at
             FROM extension_capture
            WHERE status = 'done'
            GROUP BY connector_name
         ) cap ON cap.connector_name = g.connector_name
        ORDER BY g.registered DESC, g.connector_name`,
    ),
    fetchLastRuns(),
    fetchDerivedScopeSources(),
  ]);

  const defaultIntervalHours = defaultFreshnessIntervalHours();
  const stuckAfterHours = freshnessCycleStuckAfterHours();
  const nowMs = Date.now();
  // Issue #586 — read once per call, not once per row (its own loader
  // already degrades to hardcoded defaults on failure, so this never throws;
  // see captura-staleness-config.ts).
  const stalenessConfig = getStalenessConfig();

  return registryRows.map((row) => {
    const override = parseGeographyOverride(row.geography_override);
    // Absent config row => enabled (matches the column default and the
    // ETL's "no row means issue #71's unmodified default" behaviour).
    const enabled = row.enabled ?? true;
    // Absent config row (or NULL) => capture enabled, matching the
    // `capture_enabled` column default TRUE and the poller's missing-row
    // default (etl/capture.py `_connector_capture_enabled`, issue #263).
    const captureEnabled = row.capture_enabled ?? true;
    const supportsDiscovery = row.supports_discovery;

    let scopeSource: ConnectorView["scopeSource"];
    if (!supportsDiscovery) {
      scopeSource = "capture-only";
    } else if (override) {
      scopeSource = "override";
    } else if (derivedFrom.length > 0) {
      scopeSource = "profiles";
    } else {
      scopeSource = "none";
    }

    return {
      name: row.connector_name,
      registered: row.registered,
      rate_limit_per_minute:
        row.rate_limit_per_minute === null ? null : num(row.rate_limit_per_minute),
      discovers_full_inventory: row.discovers_full_inventory,
      supports_discovery: supportsDiscovery,
      supported_filters: parseSupportedFilters(row.supported_filters),
      overrideHostSuffix: row.override_host_suffix,
      supportsSearchOverride: row.supports_search_override ?? false,
      hasSearchUrlGrammar:
        typeof row.search_url_grammar === "object" && row.search_url_grammar !== null,
      usingDefaults: !row.has_config,
      enabled,
      capture_enabled: captureEnabled,
      geography_override: override,
      filters: parseFilters(row.filters),
      scopeSource,
      // Only meaningful when the scope actually comes from profiles.
      derivedFrom: scopeSource === "profiles" ? derivedFrom : [],
      // Issue #586/D-125: SAME helper `getConnectorFreshness()` calls for the
      // TopBar dot — a capture-only portal reads its freshness from
      // extension_capture here too, not `connector_freshness_state` alone
      // (which has no rows at all for a connector whose crawl never runs).
      freshness: resolveConnectorFreshnessState({
        connectorName: row.connector_name,
        supportsDiscovery: supportsDiscovery,
        freshnessIntervalHoursRaw: row.freshness_interval_hours,
        lastFreshAt: row.last_fresh_at ?? null,
        cycleStartedAt: row.cycle_started_at ?? null,
        targetScopeCount:
          row.cycle_target_scope_count === null || row.cycle_target_scope_count === undefined
            ? null
            : num(row.cycle_target_scope_count),
        coveredScopeCount:
          row.covered_scope_count === null || row.covered_scope_count === undefined
            ? null
            : num(row.covered_scope_count),
        lastCaptureDoneAt: row.last_capture_done_at ?? null,
        defaultIntervalHours,
        stalenessConfig,
        stuckAfterHours,
        nowMs,
      }),
      lastRun: lastRuns.get(row.connector_name) ?? null,
    };
  });
}

export interface ConnectorRegistryInfo {
  name: string;
  registered: boolean;
  supports_discovery: boolean;
  supported_filters: string[];
}

/**
 * Registry metadata for one connector, or null if the name has never been
 * published at all. `registered === false` is a distinct, real state: the
 * connector existed once (so its historical run rows still resolve to a
 * name) but is no longer in the Python registry, and therefore can never
 * run again until it comes back. Callers must not treat it as writable —
 * see the PATCH route.
 */
export async function getConnectorRegistryInfo(
  name: string,
): Promise<ConnectorRegistryInfo | null> {
  const rows = await sql<{
    connector_name: string;
    registered: boolean;
    supports_discovery: boolean;
    supported_filters: unknown;
  }>(
    `SELECT connector_name, registered, supports_discovery, supported_filters
       FROM connector_registry
      WHERE connector_name = $1`,
    [name],
  );
  if (rows.length === 0) return null;
  return {
    name: rows[0].connector_name,
    registered: rows[0].registered,
    supports_discovery: rows[0].supports_discovery,
    supported_filters: parseSupportedFilters(rows[0].supported_filters),
  };
}

/**
 * Apply a partial config change, creating the `connector_config` row if it
 * doesn't exist yet (the common case — the table starts empty).
 *
 * Only the fields present in `patch` are written; everything else keeps its
 * stored value, so toggling `enabled` can never silently clear a geography
 * override an operator set earlier. This is done with COALESCE against the
 * existing row inside a single upsert rather than read-then-write, so two
 * concurrent PATCHes can't interleave into a lost update.
 */
export async function updateConnectorConfig(
  name: string,
  patch: ConnectorConfigPatch,
): Promise<void> {
  const setEnabled = patch.enabled !== undefined;
  const setCaptureEnabled = patch.capture_enabled !== undefined;
  // Distinguish "not supplied" (leave alone) from "explicitly null" (clear
  // the override) — `null` is a meaningful value here, not just absence.
  const setGeography = Object.prototype.hasOwnProperty.call(patch, "geography_override");
  const setFilters = patch.filters !== undefined;
  // Issue #295: distinguish "not supplied" (leave alone) from "explicitly null"
  // (clear the override, back to the global default) — null is meaningful here,
  // same as geography_override.
  const setFreshness = Object.prototype.hasOwnProperty.call(
    patch,
    "freshness_interval_hours",
  );

  await sql(
    `INSERT INTO connector_config (
        connector_name, enabled, capture_enabled, geography_override, filters,
        freshness_interval_hours, updated_at
     )
     VALUES (
        $1,
        COALESCE($3::boolean, true),
        -- Issue #263: a config row created by a patch that doesn't touch
        -- capture defaults to capture-enabled, matching the column default.
        COALESCE($9::boolean, true),
        $5::jsonb,
        COALESCE($7::jsonb, '{}'::jsonb),
        $11::integer,
        NOW()
     )
     ON CONFLICT (connector_name) DO UPDATE SET
        enabled = CASE WHEN $2 THEN COALESCE($3::boolean, connector_config.enabled)
                       ELSE connector_config.enabled END,
        capture_enabled = CASE WHEN $8 THEN COALESCE($9::boolean, connector_config.capture_enabled)
                               ELSE connector_config.capture_enabled END,
        geography_override = CASE WHEN $4 THEN $5::jsonb
                                  ELSE connector_config.geography_override END,
        filters = CASE WHEN $6 THEN COALESCE($7::jsonb, '{}'::jsonb)
                       ELSE connector_config.filters END,
        -- $10 = "was freshness supplied at all"; $11 = the value (null clears).
        freshness_interval_hours = CASE WHEN $10 THEN $11::integer
                                        ELSE connector_config.freshness_interval_hours END,
        updated_at = NOW()`,
    [
      name,
      setEnabled,
      setEnabled ? patch.enabled : null,
      setGeography,
      setGeography && patch.geography_override
        ? JSON.stringify(patch.geography_override)
        : null,
      setFilters,
      setFilters ? JSON.stringify(patch.filters) : null,
      setCaptureEnabled,
      setCaptureEnabled ? patch.capture_enabled : null,
      setFreshness,
      setFreshness ? (patch.freshness_interval_hours ?? null) : null,
    ],
  );
}

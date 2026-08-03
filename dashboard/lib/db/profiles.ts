/**
 * Search profile persistence — server-only (imports lib/db-write, the `pg`
 * Postgres client). Never import this from a client component; use
 * lib/profiles-schema.ts for the types/validation instead (see that file's
 * docstring for why the split exists — this file's `pg` dependency breaks
 * the browser bundle if pulled in transitively).
 */

import { sql } from "@/lib/db-write";
import {
  ScopeSchema,
  ThesisParamsSchema,
  type Scope,
  type ThesisParams,
  type SearchProfileRow,
} from "@/lib/profiles-schema";

export {
  PROPERTY_TYPES,
  ScopeSchema,
  ThesisParamsSchema,
  type Scope,
  type ThesisParams,
  type SearchProfileRow,
} from "@/lib/profiles-schema";

export interface SearchProfileRawRow {
  id: number;
  name: string;
  scope: unknown;
  thesis_params: unknown;
  archived_at: string | null;
  created_at: string;
  last_materialized_at: string | null;
  last_viewed_at: string | null;
}

// Every SELECT/RETURNING against search_profile shares this column list — one
// place to keep them in sync (issue #191 added last_materialized_at/
// last_viewed_at to a row shape five call sites read).
const SEARCH_PROFILE_COLUMNS =
  "id, name, scope, thesis_params, archived_at, created_at, last_materialized_at, last_viewed_at";

function toSearchProfileRow(raw: SearchProfileRawRow): SearchProfileRow {
  return {
    id: raw.id,
    name: raw.name,
    // Data already validated at write time; parse defensively on read too
    // (schema module may evolve — a row written under an older shape should
    // fail loudly here rather than silently reach the UI malformed). Used
    // only for single-row reads (get/create/update/archive/clone), where a
    // parse failure means *this specific write* is broken and should throw
    // loudly — see listActiveProfileEntries for the list path, where one bad
    // row must not break every other profile in the response.
    scope: ScopeSchema.parse(raw.scope),
    thesis_params: ThesisParamsSchema.parse(raw.thesis_params ?? {}),
    archived_at: raw.archived_at,
    created_at: raw.created_at,
    last_materialized_at: raw.last_materialized_at,
    last_viewed_at: raw.last_viewed_at,
  };
}

/**
 * One `search_profile` row's outcome from {@link listActiveProfileEntries} —
 * either a fully-parsed profile, or (issue #113) enough identifying
 * information to render a visibly-broken row instead of silently vanishing.
 */
export type ProfileListEntry =
  | { ok: true; profile: SearchProfileRow }
  | { ok: false; id: number; name: string; issues: string[] };

/**
 * Never throws: a malformed `scope`/`thesis_params` (e.g. a pre-D-010 row
 * that relied on the since-dropped `'{}'` column default, which fails
 * ScopeSchema's required `geography`/`property_types` fields — reachable via
 * a manual SQL insert, a seed script, or a future schema-shape migration) is
 * reported as an `{ok: false, ...}` entry carrying the human-readable
 * validation issues, rather than being silently dropped (issue #113: the
 * previous behaviour made a malformed profile vanish from the UI with zero
 * signal — the operator's only trace was a server console.warn nobody is
 * watching).
 */
export function toProfileListEntry(raw: SearchProfileRawRow): ProfileListEntry {
  const scopeResult = ScopeSchema.safeParse(raw.scope);
  const thesisResult = ThesisParamsSchema.safeParse(raw.thesis_params ?? {});
  if (!scopeResult.success || !thesisResult.success) {
    const issues = [
      ...(!scopeResult.success
        ? scopeResult.error.issues.map((i) => `scope${i.path.length > 0 ? "." + i.path.join(".") : ""}: ${i.message}`)
        : []),
      ...(!thesisResult.success
        ? thesisResult.error.issues.map(
            (i) => `thesis_params${i.path.length > 0 ? "." + i.path.join(".") : ""}: ${i.message}`,
          )
        : []),
    ];
    console.warn(`[db/profiles] search_profile id=${raw.id} has an invalid stored scope/thesis_params`, issues);
    return { ok: false, id: raw.id, name: raw.name, issues };
  }
  return {
    ok: true,
    profile: {
      id: raw.id,
      name: raw.name,
      scope: scopeResult.data,
      thesis_params: thesisResult.data,
      archived_at: raw.archived_at,
      created_at: raw.created_at,
      last_materialized_at: raw.last_materialized_at,
      last_viewed_at: raw.last_viewed_at,
    },
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Every active (non-archived) `search_profile` row, distinguishing a
 * successfully-parsed profile from one whose stored `scope`/`thesis_params`
 * fails validation (issue #113) — never drops a row outright. Backs the
 * Perfiles overview query (issue #192), which renders the `ok: false` case
 * as a visibly broken row instead of omitting it.
 */
export async function listActiveProfileEntries(): Promise<ProfileListEntry[]> {
  const rows = await sql<SearchProfileRawRow>(
    `SELECT ${SEARCH_PROFILE_COLUMNS}
     FROM search_profile
     WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );
  return rows.map(toProfileListEntry);
}

/**
 * Valid, active profiles only — the existing contract `GET /api/profiles`
 * (consumed by `ProfileSwitcher`/`ProfileForm`'s edit flow) and
 * `materializeAllProfiles` both depend on: neither can act on a profile whose
 * scope can't be parsed, so filtering here (rather than at each call site) is
 * the same behaviour as before issue #113, just built on top of
 * {@link listActiveProfileEntries} instead of duplicating the parse logic.
 */
export async function listActiveProfiles(): Promise<SearchProfileRow[]> {
  const entries = await listActiveProfileEntries();
  const profiles: SearchProfileRow[] = [];
  for (const entry of entries) {
    if (entry.ok) profiles.push(entry.profile);
  }
  return profiles;
}

export async function getProfileById(id: number): Promise<SearchProfileRow | null> {
  const rows = await sql<SearchProfileRawRow>(
    `SELECT ${SEARCH_PROFILE_COLUMNS}
     FROM search_profile
     WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? toSearchProfileRow(rows[0]) : null;
}

/**
 * Best-effort visit marker (issue #191): called from `GET /api/profiles/[id]`
 * every time the profile detail page is opened. Never throws — a failure to
 * record "last viewed" must not turn into a page error; callers should
 * `.catch()`/log rather than let this reject into a 500.
 */
export async function touchProfileViewedAt(id: number): Promise<void> {
  await sql(`UPDATE search_profile SET last_viewed_at = NOW() WHERE id = $1`, [id]);
}

export async function createProfile(
  name: string,
  scope: Scope,
  thesisParams: ThesisParams,
): Promise<SearchProfileRow> {
  const rows = await sql<SearchProfileRawRow>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, $3::jsonb)
     RETURNING ${SEARCH_PROFILE_COLUMNS}`,
    [name, JSON.stringify(scope), JSON.stringify(thesisParams)],
  );
  return toSearchProfileRow(rows[0]);
}

/**
 * Archived profiles cannot be edited — there is no unarchive path (issue #17
 * doesn't require one), so allowing edits on an archived row would leave it
 * in a confusing "archived but silently still changing" state. A caller
 * wanting to revive a profile's configuration should clone it instead
 * (cloneProfile), which explicitly creates a fresh active row.
 */
export async function updateProfile(
  id: number,
  patch: { name?: string; scope?: Scope; thesis_params?: ThesisParams },
): Promise<SearchProfileRow | null> {
  const existing = await getProfileById(id);
  if (!existing || existing.archived_at !== null) return null;

  const name = patch.name ?? existing.name;
  const scope = patch.scope ?? existing.scope;
  const thesisParams = patch.thesis_params ?? existing.thesis_params;

  const rows = await sql<SearchProfileRawRow>(
    `UPDATE search_profile
     SET name = $2, scope = $3::jsonb, thesis_params = $4::jsonb
     WHERE id = $1 AND archived_at IS NULL
     RETURNING ${SEARCH_PROFILE_COLUMNS}`,
    [id, name, JSON.stringify(scope), JSON.stringify(thesisParams)],
  );
  return rows.length > 0 ? toSearchProfileRow(rows[0]) : null;
}

/**
 * Soft-delete only. `profile_listing_state`/`feedback_event` reference
 * `search_profile` and must survive an archive (see docs/architecture/data-
 * model.md) — an unarchive path is a reasonable fast-follow, not required
 * by issue #17.
 */
export async function archiveProfile(id: number): Promise<SearchProfileRow | null> {
  const rows = await sql<SearchProfileRawRow>(
    `UPDATE search_profile
     SET archived_at = NOW()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING ${SEARCH_PROFILE_COLUMNS}`,
    [id],
  );
  return rows.length > 0 ? toSearchProfileRow(rows[0]) : null;
}

/**
 * A clone is a fresh thesis variant, not a data export: scope/thesis_params
 * copy over, feedback history does not (issue #17 Technical approach #4).
 * `profile_listing_state`/`feedback_event` reference the *original* profile's
 * id and are never touched by a clone — the new profile starts with zero
 * rows in either table, which requires no explicit action here (nothing
 * inserts a state row until task 2.4's hard-filter engine or Phase 3's
 * feedback flow runs against it).
 */
export async function cloneProfile(id: number, newName?: string): Promise<SearchProfileRow | null> {
  const existing = await getProfileById(id);
  if (!existing) return null;
  return createProfile(
    newName ?? `${existing.name} (copia)`,
    existing.scope,
    existing.thesis_params,
  );
}

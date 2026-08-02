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

interface SearchProfileRawRow {
  id: number;
  name: string;
  scope: unknown;
  thesis_params: unknown;
  archived_at: string | null;
  created_at: string;
}

function toSearchProfileRow(raw: SearchProfileRawRow): SearchProfileRow {
  return {
    id: raw.id,
    name: raw.name,
    // Data already validated at write time; parse defensively on read too
    // (schema module may evolve — a row written under an older shape should
    // fail loudly here rather than silently reach the UI malformed). Used
    // only for single-row reads (get/create/update/archive/clone), where a
    // parse failure means *this specific write* is broken and should throw
    // loudly — see toSearchProfileRowSafe for the list path, where one bad
    // row must not break every other profile in the response.
    scope: ScopeSchema.parse(raw.scope),
    thesis_params: ThesisParamsSchema.parse(raw.thesis_params ?? {}),
    archived_at: raw.archived_at,
    created_at: raw.created_at,
  };
}

/**
 * Like toSearchProfileRow, but never throws: a malformed `scope` (e.g. the
 * column's own DB-level default of '{}', which fails ScopeSchema's required
 * `geography`/`property_types` fields — reachable via a manual SQL insert, a
 * seed script, or a future schema-shape migration) is logged and skipped
 * rather than 500ing the entire list for every other, valid profile.
 */
function toSearchProfileRowSafe(raw: SearchProfileRawRow): SearchProfileRow | null {
  const scopeResult = ScopeSchema.safeParse(raw.scope);
  const thesisResult = ThesisParamsSchema.safeParse(raw.thesis_params ?? {});
  if (!scopeResult.success || !thesisResult.success) {
    console.warn(
      `[db/profiles] Skipping search_profile id=${raw.id} from list: invalid stored scope/thesis_params`,
      !scopeResult.success ? scopeResult.error.issues : undefined,
      !thesisResult.success ? thesisResult.error.issues : undefined,
    );
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    scope: scopeResult.data,
    thesis_params: thesisResult.data,
    archived_at: raw.archived_at,
    created_at: raw.created_at,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listActiveProfiles(): Promise<SearchProfileRow[]> {
  const rows = await sql<SearchProfileRawRow>(
    `SELECT id, name, scope, thesis_params, archived_at, created_at
     FROM search_profile
     WHERE archived_at IS NULL
     ORDER BY created_at DESC`,
  );
  return rows.map(toSearchProfileRowSafe).filter((r): r is SearchProfileRow => r !== null);
}

export async function getProfileById(id: number): Promise<SearchProfileRow | null> {
  const rows = await sql<SearchProfileRawRow>(
    `SELECT id, name, scope, thesis_params, archived_at, created_at
     FROM search_profile
     WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? toSearchProfileRow(rows[0]) : null;
}

export async function createProfile(
  name: string,
  scope: Scope,
  thesisParams: ThesisParams,
): Promise<SearchProfileRow> {
  const rows = await sql<SearchProfileRawRow>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, $3::jsonb)
     RETURNING id, name, scope, thesis_params, archived_at, created_at`,
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
     RETURNING id, name, scope, thesis_params, archived_at, created_at`,
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
     RETURNING id, name, scope, thesis_params, archived_at, created_at`,
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

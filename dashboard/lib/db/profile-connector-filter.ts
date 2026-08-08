/**
 * Owner-pinned search URLs per (profile × connector × section) — issue #478 P1,
 * server-only (imports lib/db-write's `pg` client). Never import from a client
 * component.
 *
 * A row is the FIXED search URL the owner chose for a connector on a profile: it
 * is that connector's recall source for that profile, superseding the derived
 * URL (the TS builder for extension portals / the Python _search_url() for HTTP
 * connectors). Consumed as TIER 0 in the search-URL resolver
 * (lib/search-url/resolve.ts) — url verbatim, above the D-051 learned-example
 * tiers. `section_key` is the parser's categoryKey (''=whole connector); NEVER
 * the task id (a hash of the filters, which orphans on profile edit). See the
 * table comment in etl/schema/init.sql and D-090.
 */

import { sql } from "@/lib/db-write";

/** The two ways an override can be created (mirrors the DB CHECK constraint). */
export type ProfileConnectorFilterSource = "manual" | "extension";

/** A `profile_connector_filter` row as read back by the resolver / API. */
export interface ProfileConnectorFilterRow {
  id: number;
  profile_id: number;
  connector: string;
  section_key: string;
  url: string;
  source: ProfileConnectorFilterSource;
  created_at: string;
  updated_at: string;
}

/**
 * Every pinned override for a profile, newest-updated first. The resolver loads
 * these once per profile and matches each task against them (WHERE profile_id =
 * $1, served by idx_profile_connector_filter_profile).
 */
export async function findOverridesForProfile(
  profileId: number,
): Promise<ProfileConnectorFilterRow[]> {
  return sql<ProfileConnectorFilterRow>(
    `SELECT id, profile_id, connector, section_key, url, source, created_at, updated_at
       FROM profile_connector_filter
      WHERE profile_id = $1
      ORDER BY updated_at DESC, id DESC`,
    [profileId],
  );
}

/** Arguments for {@link upsertProfileConnectorFilter}. */
export interface UpsertProfileConnectorFilterArgs {
  profileId: number;
  connector: string;
  /** Parser categoryKey; '' (the default) applies to the whole connector. */
  sectionKey?: string;
  url: string;
  source: ProfileConnectorFilterSource;
}

/**
 * Pin (or re-pin) an override for a (profile × connector × section). Idempotent
 * per the UNIQUE (profile_id, connector, section_key) key: a repeat pin updates
 * the URL, source and (via the set_updated_at trigger) updated_at in place.
 * Stores the URL VERBATIM — callers must not normalise it (a `shape=` drawn-zone
 * URL must survive byte-for-byte). Returns the stored row.
 */
export async function upsertProfileConnectorFilter(
  args: UpsertProfileConnectorFilterArgs,
): Promise<ProfileConnectorFilterRow> {
  const { profileId, connector, url, source } = args;
  const sectionKey = args.sectionKey ?? "";
  const rows = await sql<ProfileConnectorFilterRow>(
    `INSERT INTO profile_connector_filter (profile_id, connector, section_key, url, source)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (profile_id, connector, section_key)
       DO UPDATE SET url = EXCLUDED.url, source = EXCLUDED.source
     RETURNING id, profile_id, connector, section_key, url, source, created_at, updated_at`,
    [profileId, connector, sectionKey, url, source],
  );
  return rows[0];
}

/**
 * Remove a pinned override, reverting that (profile × connector × section) to
 * its derived URL. Returns true when a row was deleted, false when none matched.
 */
export async function deleteProfileConnectorFilter(
  profileId: number,
  connector: string,
  sectionKey = "",
): Promise<boolean> {
  const rows = await sql<{ id: number }>(
    `DELETE FROM profile_connector_filter
      WHERE profile_id = $1 AND connector = $2 AND section_key = $3
      RETURNING id`,
    [profileId, connector, sectionKey],
  );
  return rows.length > 0;
}

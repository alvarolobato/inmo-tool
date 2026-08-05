/**
 * "Novedades" summary (issue #195) — the page-level "what's new since I last
 * looked, across all profiles" glance that sits above the Perfiles rows.
 *
 * There is deliberately NO new query here (see #195 / the #176 design
 * comment): every profile's `new_count` is already computed by the Perfiles
 * overview aggregate (`lib/db/profile-overview.ts`, field
 * `ProfileOverviewMetrics.new_count` = matched properties first-seen since the
 * profile's `last_viewed_at`, or in the last 24h for a never-visited profile).
 * This module just sums/surfaces those per-profile counts at the page level,
 * so the strip and the per-row "N nuevos" metric can never disagree — they
 * read the exact same numbers.
 *
 * Pure and client-safe (no `pg` import): takes the already-fetched
 * `ProfileOverviewEntry[]` the Perfiles page holds and returns the aggregate.
 */

import type { ProfileOverviewEntry } from "@/lib/profile-overview-types";

export interface NovedadesSummary {
  /** Total new (first-seen-since-last-visit) matched candidates across all valid profiles. */
  totalNew: number;
  /** How many valid profiles have at least one new matched candidate. */
  profilesWithNew: number;
  /**
   * Ids of the profiles that have new candidates, ordered most-new-first
   * (ties broken by id asc for determinism). Drives the strip's "jump to the
   * profile that changed" click — the first id is the busiest one.
   */
  newProfileIds: number[];
}

type ValidEntry = Extract<ProfileOverviewEntry, { ok: true }>;

/**
 * Summarize the "novedades" glance from the Perfiles overview entries.
 * Malformed-scope profiles (`ok: false`, issue #113) have no matched-candidate
 * concept and are ignored. `null`/`undefined` (degraded fallback, where the
 * heavier aggregate 500'd and only the plain list loaded — no `new_count`
 * available) yields an all-zero summary so the caller renders nothing.
 */
export function summarizeNovedades(
  overviews: ProfileOverviewEntry[] | null | undefined,
): NovedadesSummary {
  if (!overviews) return { totalNew: 0, profilesWithNew: 0, newProfileIds: [] };

  const withNew = overviews
    .filter((e): e is ValidEntry => e.ok && e.metrics.new_count > 0)
    .sort(
      (a, b) => b.metrics.new_count - a.metrics.new_count || a.profile.id - b.profile.id,
    );

  return {
    totalNew: withNew.reduce((sum, e) => sum + e.metrics.new_count, 0),
    profilesWithNew: withNew.length,
    newProfileIds: withNew.map((e) => e.profile.id),
  };
}

/**
 * Quick refresh on profile create / scope-change (issue #245).
 *
 * Server-only: imports lib/filtering/materialize and lib/db/manual-trigger,
 * both of which pull in the `pg` client — never import this from a client
 * component.
 *
 * Composes two EXISTING mechanisms — it never introduces a new trigger path
 * or a second run loop:
 *
 *  1. Re-materialize (and re-score) the profile against data ALREADY in the
 *     mirror (`materializeProfile`), so the candidate list reflects the new
 *     scope the instant the save returns — without waiting for a crawl to
 *     finish.
 *  2. Enqueue an ad-hoc connector sweep by inserting an `etl_manual_trigger`
 *     row (`createManualTrigger`) — the exact D-038 mechanism `POST
 *     /api/etl/run` uses. A full sweep (`connector_name = NULL`): connectors
 *     derive their crawl scopes from ALL active `search_profile` rows, so a
 *     full sweep already covers this profile's new geography — no
 *     per-connector scoping needed (and per issue #245, a full sweep is the
 *     un-over-engineered choice). The sweep still runs through each
 *     connector's own rate limiter / circuit breaker (D-038), so this can
 *     never hammer a site harder than a manual `ps connector run`.
 *
 * Debounce / coalesce is INHERITED, not built here: `etl_manual_trigger` has a
 * single-pending-row partial unique index, so a burst of profile edits
 * collapses onto one pending sweep — the unique-violation is reported as
 * `already_pending` (with the existing pending id for the UI to poll), never
 * an error.
 *
 * Everything here is best-effort: a materialize or an enqueue failure is
 * logged and swallowed. It must never fail the profile save that triggered it
 * — a save that succeeded server-side but 500s because the follow-up refresh
 * failed would be a strictly worse outcome than a slightly-stale candidate
 * list that the next scheduled materialize/sweep fixes anyway.
 */

import { materializeProfile } from "@/lib/filtering/materialize";
import {
  createManualTrigger,
  getPendingTrigger,
  PG_UNIQUE_VIOLATION,
} from "@/lib/db/manual-trigger";
import type { ProfileRefreshResult } from "@/lib/profiles-schema";

export type { ProfileRefreshResult } from "@/lib/profiles-schema";

function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Re-materialize the profile and enqueue a full ad-hoc sweep. Call this only
 * when the crawl-relevant scope is new (create) or actually changed (a
 * scope-changing PATCH) — the caller owns that gate (see `scopesEqual`).
 */
export async function refreshProfileForScope(profileId: number): Promise<ProfileRefreshResult> {
  const result: ProfileRefreshResult = {
    materialized: false,
    crawl: { status: "error", triggerId: null },
  };

  // 1. Materialize + score against data already in the mirror (best-effort).
  try {
    const materialized = await materializeProfile(profileId);
    result.materialized = materialized !== null;
  } catch (err) {
    console.error(`[refreshProfileForScope] No se pudo materializar el perfil ${profileId}:`, err);
  }

  // 2. Enqueue a full ad-hoc sweep (best-effort, coalescing on the
  //    single-pending unique index).
  try {
    const triggerId = await createManualTrigger(null, "profile-refresh");
    result.crawl = { status: "enqueued", triggerId };
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      const pending = await getPendingTrigger().catch(() => null);
      result.crawl = { status: "already_pending", triggerId: pending?.id ?? null };
    } else {
      console.error(`[refreshProfileForScope] No se pudo encolar la búsqueda para el perfil ${profileId}:`, err);
      result.crawl = { status: "error", triggerId: null };
    }
  }

  return result;
}

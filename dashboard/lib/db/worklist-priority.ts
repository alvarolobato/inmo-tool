/**
 * Per-portal due-priority for the auto-capture continuous driver (issue #424) —
 * server-only (reads profiles, tasks, task-runs, config).
 *
 * The auto driver drains the worklist due-first: portals whose capture tasks are
 * DUE this cycle should be captured before portals that are "al día". This reuses
 * the SAME #414 staleness logic the /captura page renders — a connector's
 * due/half-done/not-due state — collapsed to a numeric rank per portal (lower =
 * more due → drained first):
 *
 *   due (nothing done this cycle)      → 0
 *   half-done (some done, some not)    → 1
 *   not-due (al día)                   → 2
 *
 * A portal is ranked by its MOST-due connector across all active profiles. A
 * portal with no profile task (e.g. sitemap-seeded / derived URLs) is simply
 * absent from the map; the pure selector (batch.js selectNextPending) then treats
 * it as lowest priority but still eligible. Never throws — a failure to compute
 * ranks degrades to an empty map (pure oldest-first ordering), so the endpoint is
 * never blocked by this best-effort context.
 */

import { listActiveProfiles } from "@/lib/db/profiles";
import { resolveSearchTasks } from "@/lib/search-url/resolve";
import { getTaskRuns } from "@/lib/db/capture-task-run";
import { getStalenessConfig } from "@/lib/captura-staleness-config";
import { buildConnectorViews, type ConnectorState } from "@/lib/captura-tasks";

/** Numeric rank for a connector state — lower drains first. */
function rankFor(state: ConnectorState): number {
  if (state === "due") return 0;
  if (state === "half-done") return 1;
  return 2; // not-due
}

/**
 * Map each portal → its most-due rank across every active profile's connectors.
 * Best-effort: returns `{}` on any error so the caller falls back to oldest-first.
 */
export async function getPortalDuePriority(): Promise<Record<string, number>> {
  const rank: Record<string, number> = {};
  try {
    const staleness = getStalenessConfig();
    const profiles = await listActiveProfiles();
    const now = new Date();
    for (const p of profiles) {
      const [tasks, runs] = await Promise.all([
        resolveSearchTasks(p.scope),
        getTaskRuns(p.id),
      ]);
      // Portal-global secondary context AND the per-profile captured counts are
      // irrelevant to the due state, so pass empty maps/record — the connector
      // state is derived purely from task staleness.
      const connectors = buildConnectorViews(
        tasks,
        runs,
        staleness,
        new Map(),
        new Map(),
        {},
        now,
      );
      for (const c of connectors) {
        const r = rankFor(c.state);
        rank[c.portal] =
          rank[c.portal] === undefined ? r : Math.min(rank[c.portal], r);
      }
    }
  } catch {
    return {};
  }
  return rank;
}

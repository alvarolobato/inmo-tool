/**
 * Auto-mode v2 harvest candidates (issue #516) — server-only (reads profiles,
 * tasks, task-runs, config).
 *
 * The auto-plan endpoint (app/api/etl/auto-plan) needs, for every active
 * profile's every capture task, whether it is DUE this cycle and how recently it
 * ran — so the pure planner (lib/auto-plan.ts) can pick the most-due one to
 * harvest. This reuses the SAME #414 staleness machinery the /captura page and
 * lib/db/worklist-priority.ts already use (resolveSearchTasks → buildConnector
 * Views), so the auto driver, the drain ranking, and the page all agree on
 * due/half-done/not-due.
 *
 * Never throws — a failure to compute candidates degrades to `[]` so the
 * endpoint can still fall back to draining / idling (best-effort, like
 * getPortalDuePriority).
 */

import { listActiveProfiles } from "@/lib/db/profiles";
import { resolveSearchTasks } from "@/lib/search-url/resolve";
import { getTaskRuns } from "@/lib/db/capture-task-run";
import { getStalenessConfig } from "@/lib/captura-staleness-config";
import { buildConnectorViews, type ConnectorState } from "@/lib/captura-tasks";
import {
  HARVEST_RANK_DUE,
  HARVEST_RANK_HALF_DONE,
  HARVEST_RANK_NOT_DUE,
  type HarvestCandidate,
} from "@/lib/auto-plan";

/** Numeric harvest rank for a connector state — lower drains first. */
function rankFor(state: ConnectorState): number {
  if (state === "due") return HARVEST_RANK_DUE;
  if (state === "half-done") return HARVEST_RANK_HALF_DONE;
  return HARVEST_RANK_NOT_DUE;
}

/**
 * Every active profile's capture tasks as harvest candidates, annotated with
 * their connector due-rank + per-task staleness. Optionally restricted to one
 * `portal`. Best-effort: returns `[]` on any error.
 */
export async function getHarvestCandidates(portal?: string): Promise<HarvestCandidate[]> {
  const out: HarvestCandidate[] = [];
  try {
    const staleness = getStalenessConfig();
    const profiles = await listActiveProfiles();
    const now = new Date();
    for (const p of profiles) {
      const [tasks, runs] = await Promise.all([
        resolveSearchTasks(p.scope, p.id),
        getTaskRuns(p.id),
      ]);
      // Per-profile captured counts are irrelevant to due state → pass {}.
      const connectors = buildConnectorViews(tasks, runs, staleness, {}, now);
      for (const c of connectors) {
        if (portal && c.portal !== portal) continue;
        const connectorRank = rankFor(c.state);
        for (const tv of c.taskViews) {
          out.push({
            profileId: p.id,
            taskId: tv.task.id,
            portal: c.portal,
            // The harvester opens the CAPTURE url (issue #529): the listing form
            // for an Idealista map-view task, else identical to task.url.
            url: tv.task.captureUrl,
            connectorRank,
            due: tv.due,
            lastRunAt: tv.lastRunAt,
          });
        }
      }
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Auto-mode v2 planner — pure selection of the ONE next auto unit (issue #516).
 *
 * Client-safe / server-safe: no `pg`, no React, no config I/O — just the
 * decision "given the current due state, what should the extension do next".
 * The server route (app/api/etl/auto-plan/route.ts) gathers the inputs (harvest
 * candidates from the profiles' tasks, the drain URL selection) and calls
 * {@link planAutoUnit}; the extension executes the returned unit.
 *
 * The three units, in priority order:
 *   1. `harvest` — open the most-DUE (profile × connector) search task, enumerate
 *      every results page, seed the discovered detail URLs, capture them, and
 *      record the task run so the staleness ledger advances. This is how NEW
 *      listings enter the pipeline automatically (v1 only re-captured the
 *      already-known worklist — see the issue).
 *   2. `drain` — no due search task, but there are already-discovered detail URLs
 *      pending in the worklist → capture that batch (v1's behaviour).
 *   3. `idle` — nothing due and nothing pending → slow-poll after `retryAfterSec`.
 *
 * Due ranking mirrors the /captura page (`buildConnectorViews` → connector state
 * due/half-done/not-due) collapsed to a numeric rank, exactly like
 * lib/db/worklist-priority.ts. This module holds only the pure ranking/selection
 * so it is unit-testable outside a DB.
 */

/** Connector-state rank for a harvest candidate — lower drains first. */
export const HARVEST_RANK_DUE = 0; // connector "due" — nothing done this cycle
export const HARVEST_RANK_HALF_DONE = 1; // connector "half-done" — some done
export const HARVEST_RANK_NOT_DUE = 2; // connector "not-due" — al día

/**
 * One openable search task, annotated with everything the planner needs to rank
 * it. Built server-side from each active profile's resolved tasks + task-runs.
 */
export interface HarvestCandidate {
  profileId: number;
  taskId: string;
  portal: string;
  /** The pre-filtered search URL (already tier-0-pin-aware, from resolveSearchTasks). */
  url: string;
  /** The task's connector state rank (due 0 < half-done 1 < not-due 2). */
  connectorRank: number;
  /** This task itself is due this cycle (never run, or its window has elapsed). */
  due: boolean;
  /** ISO of the task's last run, or null when never run (sorts most-urgent). */
  lastRunAt: string | null;
}

/** The single unit the extension should execute next. */
export type AutoPlanUnit =
  | {
      kind: "harvest";
      task: { profileId: number; taskId: string; portal: string; url: string };
    }
  | { kind: "drain"; urls: string[] }
  | { kind: "idle"; retryAfterSec: number };

/** Timestamp for oldest-first ordering; never-run (null) is the most urgent. */
function tsOf(lastRunAt: string | null): number {
  if (lastRunAt == null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(lastRunAt);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Choose the harvest candidate the extension should run next, or null when none
 * qualifies. Pure and STABLE (input order breaks remaining ties).
 *
 *   - `force` false (the default, due-only): only tasks that are DUE this cycle
 *     are eligible; among them the most-due connector wins (rank asc), then the
 *     oldest last-run (never-run first). This is the staleness-respecting path.
 *   - `force` true ("Forzar"): EVERY task is eligible (staleness ignored), ranked
 *     oldest-last-run first so repeated forcing round-robins through all tasks,
 *     then by connector rank. This is how a not-due task gets re-harvested.
 */
export function selectHarvestCandidate(
  candidates: readonly HarvestCandidate[],
  force = false,
): HarvestCandidate | null {
  const eligible = force ? candidates.slice() : candidates.filter((c) => c.due);
  if (eligible.length === 0) return null;
  const indexed = eligible.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    if (force) {
      // Round-robin: least-recently-run first, then most-due connector.
      const ta = tsOf(a.c.lastRunAt);
      const tb = tsOf(b.c.lastRunAt);
      if (ta !== tb) return ta - tb;
      if (a.c.connectorRank !== b.c.connectorRank) return a.c.connectorRank - b.c.connectorRank;
    } else {
      // Due-only: most-due connector first, then least-recently-run.
      if (a.c.connectorRank !== b.c.connectorRank) return a.c.connectorRank - b.c.connectorRank;
      const ta = tsOf(a.c.lastRunAt);
      const tb = tsOf(b.c.lastRunAt);
      if (ta !== tb) return ta - tb;
    }
    return a.i - b.i; // stable
  });
  return indexed[0].c;
}

/**
 * Build the single next auto unit: harvest a due search task if one exists,
 * else drain the already-discovered pending detail URLs, else idle. Pure — the
 * caller has already computed the candidates + the drain URL selection.
 */
export function planAutoUnit(
  candidates: readonly HarvestCandidate[],
  drainUrls: readonly string[],
  retryAfterSec: number,
  force = false,
): AutoPlanUnit {
  const harvest = selectHarvestCandidate(candidates, force);
  if (harvest) {
    return {
      kind: "harvest",
      task: {
        profileId: harvest.profileId,
        taskId: harvest.taskId,
        portal: harvest.portal,
        url: harvest.url,
      },
    };
  }
  if (drainUrls.length > 0) {
    return { kind: "drain", urls: drainUrls.slice() };
  }
  return { kind: "idle", retryAfterSec };
}

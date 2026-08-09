/**
 * Unit tests for the pure auto-mode v2 planner (issue #516):
 * selectHarvestCandidate + planAutoUnit. No DB, no network — the selection logic
 * only (harvest beats drain beats idle; most-due rank then oldest run; the
 * force/dueOnly split).
 */

import { describe, it, expect } from "vitest";
import {
  selectHarvestCandidate,
  planAutoUnit,
  HARVEST_RANK_DUE,
  HARVEST_RANK_HALF_DONE,
  HARVEST_RANK_NOT_DUE,
  type HarvestCandidate,
} from "@/lib/auto-plan";

function cand(over: Partial<HarvestCandidate>): HarvestCandidate {
  return {
    profileId: 1,
    taskId: "t",
    portal: "idealista",
    url: "https://www.idealista.com/venta-viviendas/x/",
    connectorRank: HARVEST_RANK_DUE,
    due: true,
    lastRunAt: null,
    ...over,
  };
}

describe("selectHarvestCandidate — most-due then oldest (due-only)", () => {
  it("returns null when nothing is due (non-force)", () => {
    const c = [cand({ due: false, connectorRank: HARVEST_RANK_NOT_DUE })];
    expect(selectHarvestCandidate(c, false)).toBeNull();
  });

  it("filters out not-due tasks, keeps due ones", () => {
    const notDue = cand({ taskId: "muted", due: false, connectorRank: HARVEST_RANK_HALF_DONE });
    const due = cand({ taskId: "due", due: true, connectorRank: HARVEST_RANK_HALF_DONE });
    expect(selectHarvestCandidate([notDue, due], false)?.taskId).toBe("due");
  });

  it("prefers the most-due connector rank (due 0 over half-done 1)", () => {
    const half = cand({ taskId: "half", connectorRank: HARVEST_RANK_HALF_DONE, lastRunAt: null });
    const full = cand({ taskId: "full", connectorRank: HARVEST_RANK_DUE, lastRunAt: "2026-08-01T00:00:00Z" });
    // Even though `full` ran more recently, its connector is more due → wins.
    expect(selectHarvestCandidate([half, full], false)?.taskId).toBe("full");
  });

  it("breaks a rank tie by oldest last run (never-run is most urgent)", () => {
    const recent = cand({ taskId: "recent", lastRunAt: "2026-08-08T00:00:00Z", due: true });
    const old = cand({ taskId: "old", lastRunAt: "2026-08-01T00:00:00Z", due: true });
    const never = cand({ taskId: "never", lastRunAt: null, due: true });
    expect(selectHarvestCandidate([recent, old, never], false)?.taskId).toBe("never");
    expect(selectHarvestCandidate([recent, old], false)?.taskId).toBe("old");
  });
});

describe("selectHarvestCandidate — force ignores staleness (round-robin)", () => {
  it("returns a not-due task under force (EC-4)", () => {
    const c = [cand({ taskId: "notdue", due: false, connectorRank: HARVEST_RANK_NOT_DUE })];
    expect(selectHarvestCandidate(c, false)).toBeNull();
    expect(selectHarvestCandidate(c, true)?.taskId).toBe("notdue");
  });

  it("round-robins by oldest last run first, regardless of connector rank", () => {
    const dueRecent = cand({ taskId: "dueRecent", due: true, connectorRank: HARVEST_RANK_DUE, lastRunAt: "2026-08-08T00:00:00Z" });
    const notDueOld = cand({ taskId: "notDueOld", due: false, connectorRank: HARVEST_RANK_NOT_DUE, lastRunAt: "2026-01-01T00:00:00Z" });
    // Force: least-recently-run wins even though its connector is "not-due".
    expect(selectHarvestCandidate([dueRecent, notDueOld], true)?.taskId).toBe("notDueOld");
  });
});

describe("planAutoUnit — harvest > drain > idle", () => {
  it("harvest wins even when drain URLs exist", () => {
    const unit = planAutoUnit([cand({ taskId: "h" })], ["https://x/1"], 300, false);
    expect(unit.kind).toBe("harvest");
    if (unit.kind === "harvest") {
      expect(unit.task.taskId).toBe("h");
      expect(unit.task.portal).toBe("idealista");
    }
  });

  it("drains when no task is due but pending URLs remain", () => {
    const notDue = [cand({ due: false, connectorRank: HARVEST_RANK_NOT_DUE })];
    const unit = planAutoUnit(notDue, ["https://x/1", "https://x/2"], 300, false);
    expect(unit.kind).toBe("drain");
    if (unit.kind === "drain") expect(unit.urls).toEqual(["https://x/1", "https://x/2"]);
  });

  it("idles when nothing is due and nothing is pending", () => {
    const unit = planAutoUnit([], [], 300, false);
    expect(unit).toEqual({ kind: "idle", retryAfterSec: 300 });
  });

  it("force turns a not-due task into a harvest (drain not reached)", () => {
    const notDue = [cand({ taskId: "f", due: false, connectorRank: HARVEST_RANK_NOT_DUE })];
    const unit = planAutoUnit(notDue, ["https://x/1"], 300, true);
    expect(unit.kind).toBe("harvest");
    if (unit.kind === "harvest") expect(unit.task.taskId).toBe("f");
  });
});

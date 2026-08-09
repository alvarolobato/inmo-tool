// @vitest-environment node
/**
 * Unit tests for GET /api/etl/auto-plan (issue #516). Mocks the three data
 * sources (harvest candidates, pending worklist, portal due-priority) so the
 * route exercises its REAL orchestration — candidate gathering, drain selection,
 * and the harvest/drain/idle decision — without a DB.
 *
 * Auth is enforced by middleware.ts (gate-by-default for /api/*), not the route,
 * so it is not re-tested here (see the connector-filters test for the in-route
 * defense-in-depth pattern).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/auto-plan-candidates", () => ({ getHarvestCandidates: vi.fn() }));
vi.mock("@/lib/db/worklist", () => ({ listPendingWorklist: vi.fn() }));
vi.mock("@/lib/db/worklist-priority", () => ({ getPortalDuePriority: vi.fn() }));

import { GET } from "../route";
import * as candidatesDb from "@/lib/db/auto-plan-candidates";
import * as worklistDb from "@/lib/db/worklist";
import * as priorityDb from "@/lib/db/worklist-priority";
import type { HarvestCandidate } from "@/lib/auto-plan";

const mockCandidates = vi.mocked(candidatesDb.getHarvestCandidates);
const mockPending = vi.mocked(worklistDb.listPendingWorklist);
const mockPriority = vi.mocked(priorityDb.getPortalDuePriority);

function dueCandidate(over: Partial<HarvestCandidate> = {}): HarvestCandidate {
  return {
    profileId: 3,
    taskId: "idealista-abc",
    portal: "idealista",
    url: "https://www.idealista.com/venta-viviendas/estepona/",
    connectorRank: 0,
    due: true,
    lastRunAt: null,
    ...over,
  };
}

function req(qs = ""): NextRequest {
  return new NextRequest(`http://localhost:4000/api/etl/auto-plan${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCandidates.mockResolvedValue([]);
  mockPending.mockResolvedValue([]);
  mockPriority.mockResolvedValue({});
});

describe("GET /api/etl/auto-plan", () => {
  it("returns a harvest unit for the most-due task", async () => {
    mockCandidates.mockResolvedValue([
      dueCandidate({ taskId: "half", connectorRank: 1, lastRunAt: "2026-08-01T00:00:00Z" }),
      dueCandidate({ taskId: "due", connectorRank: 0, lastRunAt: "2026-08-07T00:00:00Z" }),
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("harvest");
    // The rank-0 connector wins over the rank-1 one despite running more recently.
    expect(body.task.taskId).toBe("due");
    expect(body.task).toMatchObject({ profileId: 3, portal: "idealista" });
  });

  it("harvest→idle progression: once nothing is due and nothing is pending, it idles (EC-1)", async () => {
    // First call: a due task → harvest.
    mockCandidates.mockResolvedValueOnce([dueCandidate()]);
    const first = await (await GET(req())).json();
    expect(first.kind).toBe("harvest");

    // After the run is recorded, the task is no longer due and the worklist is
    // empty → idle with a retry hint.
    mockCandidates.mockResolvedValueOnce([]);
    mockPending.mockResolvedValueOnce([]);
    const second = await (await GET(req())).json();
    expect(second.kind).toBe("idle");
    expect(typeof second.retryAfterSec).toBe("number");
    expect(second.retryAfterSec).toBeGreaterThan(0);
  });

  it("falls back to drain when nothing is due but pending URLs remain", async () => {
    mockCandidates.mockResolvedValue([]); // no due tasks
    mockPending.mockResolvedValue([
      { url: "https://www.idealista.com/inmueble/1/", portal: "idealista", createdAt: "2026-08-01T00:00:00Z" },
      { url: "https://www.idealista.com/inmueble/2/", portal: "idealista", createdAt: "2026-08-02T00:00:00Z" },
    ]);
    // Portal must be DUE for dueOnly drain to include it.
    mockPriority.mockResolvedValue({ idealista: 0 });
    const body = await (await GET(req())).json();
    expect(body.kind).toBe("drain");
    expect(body.urls).toHaveLength(2);
  });

  it("dueOnly drain excludes not-due portals (idles when only not-due pending exists)", async () => {
    mockCandidates.mockResolvedValue([]);
    mockPending.mockResolvedValue([
      { url: "https://www.idealista.com/inmueble/1/", portal: "idealista", createdAt: "2026-08-01T00:00:00Z" },
    ]);
    mockPriority.mockResolvedValue({ idealista: 2 }); // not-due
    const body = await (await GET(req())).json();
    expect(body.kind).toBe("idle");
  });

  it("force ignores staleness — re-harvests a not-due task (EC-4)", async () => {
    const notDue = dueCandidate({ taskId: "notdue", due: false, connectorRank: 2 });
    mockCandidates.mockResolvedValue([notDue]);
    // Without force: not due, nothing pending → idle.
    expect((await (await GET(req())).json()).kind).toBe("idle");
    // With force: the not-due task becomes a harvest.
    const forced = await (await GET(req("?force=1"))).json();
    expect(forced.kind).toBe("harvest");
    expect(forced.task.taskId).toBe("notdue");
  });

  it("passes the portal filter through to the candidate + pending lookups", async () => {
    await GET(req("?portal=aliseda"));
    expect(mockCandidates).toHaveBeenCalledWith("aliseda");
    expect(mockPending).toHaveBeenCalledWith("aliseda");
  });

  it("500 when a data source throws", async () => {
    mockPending.mockRejectedValue(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});

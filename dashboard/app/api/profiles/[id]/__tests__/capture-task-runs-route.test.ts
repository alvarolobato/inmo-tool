// @vitest-environment node
/**
 * Unit tests for the capture task-run ledger route (issue #289):
 *   GET  /api/profiles/[id]/capture-task-runs  → runs + staleness config
 *   POST /api/profiles/[id]/capture-task-runs  → record a task run
 *
 * Mocks the DB access (getProfileById, get/recordTaskRun) and the config reader
 * so no real Postgres or config.yaml is needed — the route's job is validation
 * + wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/profiles", () => ({ getProfileById: vi.fn() }));
vi.mock("@/lib/db/capture-task-run", () => ({
  getTaskRuns: vi.fn(),
  recordTaskRun: vi.fn(),
  getPortalCaptureActivity: vi.fn(),
}));
vi.mock("@/lib/captura-staleness-config", () => ({ getStalenessConfig: vi.fn() }));

import { GET, POST } from "../capture-task-runs/route";
import * as profiles from "@/lib/db/profiles";
import * as ledger from "@/lib/db/capture-task-run";
import * as stalenessCfg from "@/lib/captura-staleness-config";
import type { SearchProfileRow } from "@/lib/profiles-schema";

const mockGetProfile = vi.mocked(profiles.getProfileById);
const mockGetRuns = vi.mocked(ledger.getTaskRuns);
const mockRecord = vi.mocked(ledger.recordTaskRun);
const mockActivity = vi.mocked(ledger.getPortalCaptureActivity);
const mockStaleness = vi.mocked(stalenessCfg.getStalenessConfig);

function makeProfile(): SearchProfileRow {
  return {
    id: 7,
    name: "Centro Madrid",
    scope: {
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 8 },
      property_types: ["piso"],
      hard_exclusions: {},
    },
    thesis_params: {},
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_materialized_at: null,
    last_viewed_at: null,
  };
}

function getReq(id = "7"): NextRequest {
  return new NextRequest(`http://localhost:4000/api/profiles/${id}/capture-task-runs`);
}

function postReq(id = "7", body: unknown = { taskId: "t1" }): NextRequest {
  return new NextRequest(`http://localhost:4000/api/profiles/${id}/capture-task-runs`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function ctx(id = "7") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStaleness.mockReturnValue({ defaultDays: 7, byPortal: { idealista: 3 } });
  mockActivity.mockResolvedValue([
    { portal: "idealista", captured: 10, lastCapturedAt: "2026-08-04T00:00:00.000Z" },
    { portal: "aliseda", captured: 0, lastCapturedAt: null },
  ]);
});

describe("GET /api/profiles/[id]/capture-task-runs", () => {
  it("returns runs + staleness for an existing profile", async () => {
    mockGetProfile.mockResolvedValue(makeProfile());
    mockGetRuns.mockResolvedValue({ t1: "2026-08-01T00:00:00.000Z" });
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profileId).toBe(7);
    expect(body.runs).toEqual({ t1: "2026-08-01T00:00:00.000Z" });
    expect(body.staleness).toEqual({ defaultDays: 7, byPortal: { idealista: 3 } });
    // REAL capture activity from extension_capture is surfaced too.
    expect(body.activity).toEqual([
      { portal: "idealista", captured: 10, lastCapturedAt: "2026-08-04T00:00:00.000Z" },
      { portal: "aliseda", captured: 0, lastCapturedAt: null },
    ]);
    expect(mockGetRuns).toHaveBeenCalledWith(7);
    expect(mockActivity).toHaveBeenCalled();
  });

  it("400 on a non-numeric id", async () => {
    const res = await GET(getReq("abc"), ctx("abc"));
    expect(res.status).toBe(400);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it("404 when the profile does not exist", async () => {
    mockGetProfile.mockResolvedValue(null);
    const res = await GET(getReq("999"), ctx("999"));
    expect(res.status).toBe(404);
  });

  it("500 when the DB read throws", async () => {
    mockGetProfile.mockResolvedValue(makeProfile());
    mockGetRuns.mockRejectedValue(new Error("boom"));
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(500);
  });
});

describe("POST /api/profiles/[id]/capture-task-runs", () => {
  it("records a run and returns the timestamp", async () => {
    mockGetProfile.mockResolvedValue(makeProfile());
    mockRecord.mockResolvedValue("2026-08-05T12:00:00.000Z");
    const res = await POST(postReq("7", { taskId: "t1" }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, taskId: "t1", lastRunAt: "2026-08-05T12:00:00.000Z" });
    expect(mockRecord).toHaveBeenCalledWith(7, "t1");
  });

  it("trims the taskId before recording", async () => {
    mockGetProfile.mockResolvedValue(makeProfile());
    mockRecord.mockResolvedValue("2026-08-05T12:00:00.000Z");
    await POST(postReq("7", { taskId: "  spaced  " }), ctx());
    expect(mockRecord).toHaveBeenCalledWith(7, "spaced");
  });

  it("400 on a non-numeric id", async () => {
    const res = await POST(postReq("abc", { taskId: "t1" }), ctx("abc"));
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("400 when taskId is missing", async () => {
    const res = await POST(postReq("7", {}), ctx());
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("400 when taskId is blank", async () => {
    const res = await POST(postReq("7", { taskId: "   " }), ctx());
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON", async () => {
    const bad = new NextRequest("http://localhost:4000/api/profiles/7/capture-task-runs", {
      method: "POST",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(bad, ctx());
    expect(res.status).toBe(400);
  });

  it("404 when the profile does not exist", async () => {
    mockGetProfile.mockResolvedValue(null);
    const res = await POST(postReq("999", { taskId: "t1" }), ctx("999"));
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("500 when recording throws", async () => {
    mockGetProfile.mockResolvedValue(makeProfile());
    mockRecord.mockRejectedValue(new Error("boom"));
    const res = await POST(postReq("7", { taskId: "t1" }), ctx());
    expect(res.status).toBe(500);
  });
});

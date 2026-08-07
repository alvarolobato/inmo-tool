// @vitest-environment node
/**
 * Unit tests for the worklist API routes (issue #237). Auth is enforced by
 * middleware (the `/api/etl/:path*` matcher), not in these handlers — same as
 * the connector-management routes — so these cover request validation and the
 * add/list plumbing with @/lib/db/worklist mocked (no real DB needed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/worklist", () => ({
  addWorklistUrls: vi.fn(),
  listWorklist: vi.fn(),
  listPendingWorklist: vi.fn(),
}));
vi.mock("@/lib/db/worklist-priority", () => ({
  getPortalDuePriority: vi.fn(),
}));

import { GET, POST } from "../route";
import * as db from "@/lib/db/worklist";
import * as prio from "@/lib/db/worklist-priority";

const mockAdd = vi.mocked(db.addWorklistUrls);
const mockList = vi.mocked(db.listWorklist);
const mockPending = vi.mocked(db.listPendingWorklist);
const mockDue = vi.mocked(prio.getPortalDuePriority);

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/etl/worklist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/etl/worklist", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a body with no urls", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("rejects an empty url list", async () => {
    const res = await POST(post({ urls: "   \n  " }));
    expect(res.status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("accepts a newline-separated text blob and passes split URLs through", async () => {
    mockAdd.mockResolvedValue({ added: 2, duplicate: 0, invalid: [] });
    const res = await POST(
      post({
        urls:
          "https://www.alisedainmobiliaria.com/inmueble/ANT1\n" +
          "https://www.alisedainmobiliaria.com/inmueble/ANT2",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, added: 2, duplicate: 0 });
    expect(mockAdd).toHaveBeenCalledWith(
      [
        "https://www.alisedainmobiliaria.com/inmueble/ANT1",
        "https://www.alisedainmobiliaria.com/inmueble/ANT2",
      ],
      "manual",
    );
  });

  it("accepts an array of urls", async () => {
    mockAdd.mockResolvedValue({ added: 1, duplicate: 0, invalid: [] });
    const res = await POST(post({ urls: ["https://www.alisedainmobiliaria.com/inmueble/ANT9"] }));
    expect(res.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledWith(
      ["https://www.alisedainmobiliaria.com/inmueble/ANT9"],
      "manual",
    );
  });

  it("passes via='derived' through when the extension harvested the URLs (issue #262)", async () => {
    mockAdd.mockResolvedValue({ added: 1, duplicate: 0, invalid: [] });
    const res = await POST(
      post({ urls: ["https://www.idealista.com/inmueble/1/"], via: "derived" }),
    );
    expect(res.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledWith(["https://www.idealista.com/inmueble/1/"], "derived");
  });

  it("falls back to via='manual' for an unknown via value", async () => {
    mockAdd.mockResolvedValue({ added: 1, duplicate: 0, invalid: [] });
    const res = await POST(
      post({ urls: ["https://www.idealista.com/inmueble/1/"], via: "bogus" }),
    );
    expect(res.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledWith(["https://www.idealista.com/inmueble/1/"], "manual");
  });

  it("surfaces a 500 when the DB helper throws", async () => {
    mockAdd.mockRejectedValue(new Error("boom"));
    const res = await POST(post({ urls: ["https://www.alisedainmobiliaria.com/inmueble/ANT1"] }));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/etl/worklist", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns rows and summaries", async () => {
    mockList.mockResolvedValue({
      rows: [],
      summaries: [
        { source_portal: "aliseda", total: 3, pending: 1, captured: 2, failed: 0, skipped: 0, stale: 0 },
      ],
    });
    const req = new NextRequest("http://localhost:4000/api/etl/worklist?portal=aliseda");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaries[0].captured).toBe(2);
    expect(mockList).toHaveBeenCalledWith("aliseda");
  });
});

describe("GET /api/etl/worklist?pending — auto-driver next batch (issue #424)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the next ≤N pending URLs prioritised due-first then oldest", async () => {
    mockPending.mockResolvedValue([
      { url: "u-alt", portal: "altamira", createdAt: "2026-01-01T00:00:00Z" },
      { url: "u-ide-new", portal: "idealista", createdAt: "2026-03-01T00:00:00Z" },
      { url: "u-ide-old", portal: "idealista", createdAt: "2026-02-01T00:00:00Z" },
    ]);
    mockDue.mockResolvedValue({ idealista: 0 }); // idealista due; altamira unknown

    const req = new NextRequest("http://localhost:4000/api/etl/worklist?pending=1&limit=2");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    // due idealista (oldest first), capped at 2 → excludes altamira.
    expect(body.urls).toEqual(["u-ide-old", "u-ide-new"]);
    expect(body.totalPending).toBe(3);
  });

  it("clamps limit to the server max and defaults when absent", async () => {
    mockPending.mockResolvedValue([]);
    mockDue.mockResolvedValue({});
    const res = await GET(
      new NextRequest("http://localhost:4000/api/etl/worklist?pending=1&limit=99999"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.urls).toEqual([]);
    expect(body.totalPending).toBe(0);
  });

  it("passes a portal filter through to the pending query", async () => {
    mockPending.mockResolvedValue([]);
    mockDue.mockResolvedValue({});
    await GET(
      new NextRequest("http://localhost:4000/api/etl/worklist?pending=1&portal=idealista"),
    );
    expect(mockPending).toHaveBeenCalledWith("idealista");
  });

  it("500s when the pending query throws", async () => {
    mockPending.mockRejectedValue(new Error("db down"));
    mockDue.mockResolvedValue({});
    const res = await GET(
      new NextRequest("http://localhost:4000/api/etl/worklist?pending=1"),
    );
    expect(res.status).toBe(500);
  });
});

describe("GET /api/etl/worklist?pending — dueOnly filter vs Forzar (issue #434)", () => {
  beforeEach(() => vi.clearAllMocks());

  const items = [
    { url: "u-ide", portal: "idealista", createdAt: "2026-02-01T00:00:00Z" }, // due (0)
    { url: "u-alt", portal: "altamira", createdAt: "2026-01-01T00:00:00Z" }, // not-due (2)
    { url: "u-cim", portal: "cimenta2", createdAt: "2026-01-05T00:00:00Z" }, // unknown
  ];

  it("defaults to due-only: excludes not-due and unknown portals", async () => {
    mockPending.mockResolvedValue(items);
    mockDue.mockResolvedValue({ idealista: 0, altamira: 2 });
    const res = await GET(
      new NextRequest("http://localhost:4000/api/etl/worklist?pending=1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.urls).toEqual(["u-ide"]); // only the due portal survives
    expect(body.dueOnly).toBe(true);
    expect(body.totalPending).toBe(3); // count is all pending, for display
  });

  it("dueOnly=0 (Forzar) returns the full pending set", async () => {
    mockPending.mockResolvedValue(items);
    mockDue.mockResolvedValue({ idealista: 0, altamira: 2 });
    const res = await GET(
      new NextRequest("http://localhost:4000/api/etl/worklist?pending=1&dueOnly=0"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.urls).toEqual(["u-ide", "u-alt", "u-cim"]); // due (0), not-due (2), unknown (99)
    expect(body.dueOnly).toBe(false);
  });

  it("dueOnly=1 explicit behaves like the default", async () => {
    mockPending.mockResolvedValue(items);
    mockDue.mockResolvedValue({ idealista: 0, altamira: 2 });
    const res = await GET(
      new NextRequest("http://localhost:4000/api/etl/worklist?pending=1&dueOnly=1"),
    );
    const body = await res.json();
    expect(body.urls).toEqual(["u-ide"]);
    expect(body.dueOnly).toBe(true);
  });

  it("due-only returns [] when nothing is due — driver idles, no spin", async () => {
    mockPending.mockResolvedValue([
      { url: "u-alt", portal: "altamira", createdAt: "2026-01-01T00:00:00Z" },
    ]);
    mockDue.mockResolvedValue({ altamira: 2 });
    const res = await GET(
      new NextRequest("http://localhost:4000/api/etl/worklist?pending=1"),
    );
    const body = await res.json();
    expect(body.urls).toEqual([]);
    expect(body.totalPending).toBe(1);
  });
});

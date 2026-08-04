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
}));

import { GET, POST } from "../route";
import * as db from "@/lib/db/worklist";

const mockAdd = vi.mocked(db.addWorklistUrls);
const mockList = vi.mocked(db.listWorklist);

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
        { source_portal: "aliseda", total: 3, pending: 1, captured: 2, failed: 0, skipped: 0 },
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

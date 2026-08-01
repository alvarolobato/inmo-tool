import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockFetch = vi.fn();

vi.mock("@/lib/llm-tools/logging", () => ({
  fetchToolCallAggregates: (...args: unknown[]) => mockFetch(...args),
}));

import { GET } from "../route";

function adminRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/admin/tool-calls", {
    headers: { "x-admin-key": process.env.ADMIN_API_KEY ?? "" },
  });
}

describe("GET /api/admin/tool-calls", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", "test-admin-secret");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without admin key", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/tool-calls");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns aggregates JSON", async () => {
    mockFetch.mockResolvedValue([
      {
        endpoint: "generateDashboard",
        tool_name: "list_ps_tables",
        status: "ok",
        calls: 3,
        avg_latency_ms: 12,
        total_payload_in: "100",
        total_payload_out: "200",
      },
    ]);

    const res = await GET(adminRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window_days).toBe(30);
    expect(body.aggregates).toHaveLength(1);
    expect(body.aggregates[0].tool_name).toBe("list_ps_tables");
  });
});

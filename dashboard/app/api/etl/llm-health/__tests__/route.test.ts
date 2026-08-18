// @vitest-environment node
/**
 * Unit tests for the LLM-health API route (issue #324). Auth is enforced by
 * middleware (`/api/etl/:path*` gate), not in this handler — same as the
 * data-health/worklist routes — so these cover the success shape and the
 * error-to-500 mapping with @/lib/db/llm-health mocked (no real DB needed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmHealthResponse } from "@/lib/llm-health";

vi.mock("@/lib/db/llm-health", () => ({
  getLlmHealth: vi.fn(),
}));

import { GET } from "../route";
import * as db from "@/lib/db/llm-health";

const mockGet = vi.mocked(db.getLlmHealth);

const SAMPLE: LlmHealthResponse = {
  flows: [
    { endpoint: "occupancy", calls_today: 1, calls_7d: 5, tokens_today: 100, tokens_7d: 500 },
  ],
  providers: [
    {
      provider: "openrouter",
      is_cli: false,
      calls_today: 1,
      calls_7d: 5,
      tokens_today: 100,
      tokens_7d: 500,
      cost_today_eur: 0.1,
      cost_7d_eur: 0.5,
    },
  ],
  cost: { cost_today_eur: 0.1, cost_7d_eur: 0.5, unpriced_models: [] },
  coverage: {
    eligible: 10,
    covered: 6,
    pending: 4,
    coverage_fraction: 0.6,
    projected_ticks: 1,
    projected_seconds: 0,
    projected_cost_eur: 0.4,
    avg_cost_eur_per_property: 0.1,
  },
  scheduler: { enabled: true, batch_size: 5, interval_seconds: 900 },
  errors: { errors_today: 0, errors_7d: 0, by_code: [] },
  tokens_logged: true,
  cli_zero_usage_24h: 0,
  generated_at: "2026-08-05T00:00:00.000Z",
};

beforeEach(() => {
  mockGet.mockReset();
});

describe("GET /api/etl/llm-health", () => {
  it("returns the aggregated payload with 200", async () => {
    mockGet.mockResolvedValue(SAMPLE);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(SAMPLE);
  });

  it("maps a DB failure to a sanitized 500 error envelope", async () => {
    mockGet.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.code).toBe("DB_QUERY");
  });
});

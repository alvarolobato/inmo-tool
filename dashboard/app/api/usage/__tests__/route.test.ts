import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({
  sql: mockSql,
}));

import { GET } from "../route";

const ZERO_STATS = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  estimated_cost_usd: "0.000000",
};

describe("GET /api/usage", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("returns 200 with zero-shape when both queries return empty rows", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("today");
    expect(data).toHaveProperty("week");
    expect(data).toHaveProperty("month");
    expect(data).toHaveProperty("by_endpoint");
    expect(data).toHaveProperty("by_provider");
    expect(data.today).toEqual(ZERO_STATS);
    expect(data.week).toEqual(ZERO_STATS);
    expect(data.month).toEqual(ZERO_STATS);
    expect(data.by_endpoint).toEqual([]);
    expect(data.by_provider).toEqual([]);
  });

  it("returns 200 with zero-shape when period row has null values", async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          today_prompt: null,
          today_completion: null,
          today_total: null,
          today_cost: null,
          week_prompt: null,
          week_completion: null,
          week_total: null,
          week_cost: null,
          month_prompt: null,
          month_completion: null,
          month_total: null,
          month_cost: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.today).toEqual(ZERO_STATS);
    expect(data.week).toEqual(ZERO_STATS);
    expect(data.month).toEqual(ZERO_STATS);
    expect(data.by_provider).toEqual([]);
  });

  it("returns correct aggregates when data is present", async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          today_prompt: "100",
          today_completion: "200",
          today_total: "300",
          today_cost: "0.003450",
          week_prompt: "500",
          week_completion: "1000",
          week_total: "1500",
          week_cost: "0.017250",
          month_prompt: "2000",
          month_completion: "4000",
          month_total: "6000",
          month_cost: "0.069000",
        },
      ])
      .mockResolvedValueOnce([
        {
          endpoint: "generateDashboard",
          calls: 3,
          total_tokens: 1200,
          estimated_cost_usd: "0.018000",
        },
      ])
      .mockResolvedValueOnce([
        {
          llm_provider: "openrouter",
          calls: 10,
          total_tokens: 5000,
          estimated_cost_usd: "0.050000",
        },
      ]);

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.today).toEqual({
      prompt_tokens: 100,
      completion_tokens: 200,
      total_tokens: 300,
      estimated_cost_usd: "0.003450",
    });
    expect(data.week.total_tokens).toBe(1500);
    expect(data.month.total_tokens).toBe(6000);
    expect(data.by_endpoint).toHaveLength(1);
    expect(data.by_endpoint[0]).toEqual({
      endpoint: "generateDashboard",
      endpoint_label_es: "Generar dashboard",
      endpoint_detail_es: expect.stringContaining("lenguaje natural"),
      calls: 3,
      total_tokens: 1200,
      estimated_cost_usd: "0.018000",
    });
    expect(data.by_provider).toEqual([
      {
        llm_provider: "openrouter",
        calls: 10,
        total_tokens: 5000,
        estimated_cost_usd: "0.050000",
        cache_creation_tokens: null,
        cache_read_tokens: null,
        cache_hit_rate_pct: null,
      },
    ]);
  });

  it("returns 200 with zero-shape when DB throws an error", async () => {
    mockSql.mockRejectedValue(new Error("DB connection failed"));

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.today).toEqual(ZERO_STATS);
    expect(data.week).toEqual(ZERO_STATS);
    expect(data.month).toEqual(ZERO_STATS);
    expect(data.by_endpoint).toEqual([]);
    expect(data.by_provider).toEqual([]);
  });

  it("by_endpoint list has all required keys per entry", async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          today_prompt: 0,
          today_completion: 0,
          today_total: 0,
          today_cost: 0,
          week_prompt: 0,
          week_completion: 0,
          week_total: 0,
          week_cost: 0,
          month_prompt: 0,
          month_completion: 0,
          month_total: 0,
          month_cost: 0,
        },
      ])
      .mockResolvedValueOnce([
        { endpoint: "modifyDashboard", calls: 2, total_tokens: 800, estimated_cost_usd: "0.012000" },
        { endpoint: "generateDashboard", calls: 1, total_tokens: 400, estimated_cost_usd: "0.006000" },
      ])
      .mockResolvedValueOnce([]);

    const res = await GET();
    const data = await res.json();

    for (const entry of data.by_endpoint) {
      expect(entry).toHaveProperty("endpoint");
      expect(entry).toHaveProperty("endpoint_label_es");
      expect(entry).toHaveProperty("endpoint_detail_es");
      expect(entry).toHaveProperty("calls");
      expect(entry).toHaveProperty("total_tokens");
      expect(entry).toHaveProperty("estimated_cost_usd");
    }
  });
});

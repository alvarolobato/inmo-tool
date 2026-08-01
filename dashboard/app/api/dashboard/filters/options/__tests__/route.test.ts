// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn(),
}));

const { mockValidateQueryCost } = vi.hoisted(() => ({
  mockValidateQueryCost: vi.fn().mockResolvedValue(1),
}));

vi.mock("@/lib/query-validator", async () => {
  const actual = await vi.importActual<typeof import("@/lib/query-validator")>(
    "@/lib/query-validator",
  );
  return {
    ...actual,
    validateQueryCost: mockValidateQueryCost,
  };
});

import { POST } from "../route";
import { query } from "@/lib/db";
import { sql } from "@/lib/db-write";
import { NextRequest } from "next/server";

const mockQuery = vi.mocked(query);
const mockSql = vi.mocked(sql);

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/filters/options", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const STORED_SPEC = {
  title: "T",
  widgets: [{ type: "table", title: "W", sql: "SELECT 1" }],
  filters: [
    {
      id: "tienda",
      type: "single_select",
      label: "Tienda",
      bind_expr: `v."tienda"`,
      value_type: "text",
      options_sql:
        'SELECT DISTINCT v."tienda" AS value, v."tienda" AS label FROM "public"."ps_ventas" v WHERE v."entrada" = true LIMIT 5',
    },
  ],
};

describe("POST /api/dashboard/filters/options", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSql.mockReset();
    mockValidateQueryCost.mockReset();
    mockValidateQueryCost.mockResolvedValue(1);
  });

  it("returns options for a valid filter", async () => {
    mockSql.mockResolvedValueOnce([{ spec: STORED_SPEC }]);
    mockQuery.mockResolvedValueOnce({
      columns: ["value", "label"],
      rows: [
        ["01", "01"],
        ["02", "02"],
      ],
    });

    const res = await POST(
      req({
        dashboardId: 7,
        filterId: "tienda",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.options).toEqual([
      { value: "01", label: "01" },
      { value: "02", label: "02" },
    ]);
    expect(mockValidateQueryCost).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when dashboard is missing", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await POST(req({ dashboardId: 999, filterId: "tienda" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when filter id is unknown", async () => {
    mockSql.mockResolvedValueOnce([{ spec: STORED_SPEC }]);
    const res = await POST(req({ dashboardId: 1, filterId: "no_existe" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when dateRange strings are not valid dates", async () => {
    mockSql.mockResolvedValueOnce([{ spec: STORED_SPEC }]);
    const res = await POST(
      req({
        dashboardId: 1,
        filterId: "tienda",
        dateRange: { from: "not-a-date", to: "also-bad" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts activeFilters with numeric scalars and arrays", async () => {
    const specWithTwo = {
      title: "T",
      widgets: [{ type: "table", title: "W", sql: "SELECT 1" }],
      filters: [
        STORED_SPEC.filters[0],
        {
          id: "familia",
          type: "multi_select",
          label: "Familia",
          bind_expr: "fm.x",
          value_type: "numeric",
          options_sql: "SELECT 1 AS value, 1 AS label",
        },
      ],
    };
    mockSql.mockResolvedValueOnce([{ spec: specWithTwo }]);
    mockQuery.mockResolvedValueOnce({
      columns: ["value", "label"],
      rows: [["1", "1"]],
    });

    const res = await POST(
      req({
        dashboardId: 1,
        filterId: "familia",
        activeFilters: { tienda: 7, other: [1, 2, 3] },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalled();
  });
});

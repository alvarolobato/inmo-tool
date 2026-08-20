// @vitest-environment node
/**
 * Unit tests for GET /api/data-health's error branch (issue #586).
 *
 * The whole point of this route's `catch` block is that a DB error must
 * degrade to an explicit "unknown" state, NEVER a silent "nothing due" —
 * before this fix it returned `overallStale: false` on any error, which is
 * indistinguishable from a genuinely healthy pipeline (one of the two
 * secondary green-washing paths issue #586 names). `@/lib/db/freshness` is
 * mocked so this doesn't need a real DB — the real-Postgres coverage for the
 * capture-portal scope correction itself lives in
 * `lib/db/__tests__/freshness.integration.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import type { DataHealthResponse } from "@/lib/db/freshness";

vi.mock("@/lib/db/freshness", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/freshness")>(
    "@/lib/db/freshness",
  );
  return { ...actual, getConnectorFreshness: vi.fn() };
});

import { GET } from "../route";
import * as freshness from "@/lib/db/freshness";

const mockGet = vi.mocked(freshness.getConnectorFreshness);

describe("GET /api/data-health", () => {
  it("degrades a DB/query error to overallUnknown:true, never overallStale:false alone (issue #586)", async () => {
    mockGet.mockRejectedValueOnce(new Error("connection terminated"));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataHealthResponse;

    // The mutation-guard assertion: a naive "degrade to empty" fix would
    // satisfy overallStale:false alone. This must ALSO assert unknown.
    expect(body.overallUnknown).toBe(true);
    expect(body.overallStale).toBe(false);
    expect(body.overallRefreshing).toBe(false);
    expect(body.stalestConnector).toBeNull();
    expect(body.connectors).toEqual([]);
  });

  it("passes through a successful getConnectorFreshness result unchanged", async () => {
    const healthy: DataHealthResponse = {
      connectors: [
        {
          connector: "fotocasa",
          enabled: true,
          inScope: true,
          lastSuccessAt: new Date().toISOString(),
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "ok",
          state: "fresh",
          isStale: false,
        },
      ],
      overallStale: false,
      overallRefreshing: false,
      overallUnknown: false,
      stalestConnector: {
        connector: "fotocasa",
        lastSuccessAt: new Date().toISOString(),
        lastRunStatus: "ok",
      },
      freshestSuccessAt: new Date().toISOString(),
    };
    mockGet.mockResolvedValueOnce(healthy);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataHealthResponse;
    expect(body.overallUnknown).toBe(false);
    expect(body.connectors).toHaveLength(1);
  });
});

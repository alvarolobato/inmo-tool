// @vitest-environment node
/**
 * Unit tests for the data-health API route (issue #272). Auth is enforced by
 * middleware (`/api/etl/:path*` gate), not in this handler — same as the
 * worklist/connector routes — so these cover the success shape and the
 * error-to-500 mapping with @/lib/db/data-health mocked (no real DB needed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataHealthResponse } from "@/lib/data-health";

vi.mock("@/lib/db/data-health", () => ({
  getDataHealth: vi.fn(),
}));

import { GET } from "../route";
import * as db from "@/lib/db/data-health";

const mockGet = vi.mocked(db.getDataHealth);

const SAMPLE: DataHealthResponse = {
  connectors: [
    {
      connector_name: "idealista",
      last_status: "ok",
      last_run_at: "2026-08-05T00:00:00.000Z",
      discovered_count: 10,
      fetched_count: 10,
      error_count: 0,
      skipped_count: 0,
      prev_error_count: 0,
      notice: "nota: presupuesto agotado",
      error_msg: null,
      ms_per_listing: 420,
    },
  ],
  portals: [
    {
      portal: "idealista",
      pending_count: 2,
      oldest_pending_age_seconds: 42,
      done_7d: 9,
      failed_7d: 1,
      listing_7d: 3,
      avg_fields_ratio_7d: 0.8,
      avg_photo_count_7d: 5,
      median_render_wait_ms_7d: 1800,
      median_queue_wait_ms_7d: 5000,
      median_processing_ms_7d: 260,
    },
  ],
  sources: [{ source: "idealista", listing_count: 100, avg_photo_count: 6 }],
  stale_profiles: [],
  zero_result_regressions: [],
  sweep_in_progress: false,
  extension_blocks: [],
  generated_at: "2026-08-05T00:00:00.000Z",
};

describe("GET /api/etl/data-health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the aggregated health payload", async () => {
    mockGet.mockResolvedValue(SAMPLE);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataHealthResponse;
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0].notice).toContain("presupuesto");
    expect(body.portals[0].portal).toBe("idealista");
    // Issue #292: search/listing-page captures are surfaced as a neutral count,
    // never folded into failed_7d.
    expect(body.portals[0].listing_7d).toBe(3);
    expect(body.portals[0].failed_7d).toBe(1);
    expect(body.sources[0].listing_count).toBe(100);
    expect(body.stale_profiles).toEqual([]);
  });

  it("maps a DB failure to a sanitized 500 with a generic user message", async () => {
    mockGet.mockRejectedValue(
      new Error("could not connect to postgresql://user:secret@db:5432/inmotool"),
    );
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DB_QUERY");
    expect(body.error).toBe("No se pudo cargar la salud de datos. Inténtalo de nuevo.");
    // The DSN (with credentials) is redacted, never echoed verbatim.
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).toContain("[DSN redacted]");
  });
});

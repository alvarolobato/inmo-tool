/**
 * "En seguimiento" watchlist queries — unit tests (issue #428, Feed phase 5).
 *
 * `@/lib/db-write`'s `sql` and the config loader are mocked, so this exercises
 * the query WIRING (which query runs, which bound params it carries — notably
 * the sanity-band fractions and the visit anchor) and the row→item mapping. The
 * drops-only / tracked-only / sanity-band FILTER itself lives in SQL and is
 * proven end-to-end by seguimiento-alerts.spec.ts against real Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sql = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>();
vi.mock("@/lib/db-write", () => ({ sql: (t: string, p?: unknown[]) => sql(t, p) }));

const getSystemConfig = vi.fn<() => Record<string, { value: unknown }>>(() => ({}));
vi.mock("@/lib/system-config/loader", () => ({ getSystemConfig: () => getSystemConfig() }));

import {
  loadSeguimientoPriceDrops,
  loadSeguimientoStatusChanges,
  countSeguimientoRecentDrops,
  readPriceChangeBand,
} from "../seguimiento";

beforeEach(() => {
  sql.mockReset();
  getSystemConfig.mockReturnValue({});
  vi.unstubAllEnvs();
});

describe("readPriceChangeBand", () => {
  it("defaults to the phase-2 1% / 60% band as fractions", () => {
    expect(readPriceChangeBand()).toEqual({ minFrac: 0.01, maxFrac: 0.6 });
  });

  it("reads env overrides and reuses the SAME feed keys as the BAJADA badge", () => {
    vi.stubEnv("FEED_PRICE_CHANGE_MIN_PCT", "2");
    vi.stubEnv("FEED_PRICE_CHANGE_MAX_PCT", "50");
    expect(readPriceChangeBand()).toEqual({ minFrac: 0.02, maxFrac: 0.5 });
  });
});

describe("loadSeguimientoPriceDrops", () => {
  it("restricts to the tracked set, passes the band + anchor as bound params, and maps rows", async () => {
    sql.mockResolvedValue([
      { property_id: 9, address: "Triana", source: "idealista", url: "https://x/9", old_price: "300000", new_price: "274200", observed_at: "2026-08-04T12:00:00Z" },
    ]);
    const out = await loadSeguimientoPriceDrops(7, "2026-08-04T00:00:00.000Z", { minFrac: 0.01, maxFrac: 0.6 }, 25);

    const [text, params] = sql.mock.calls[0];
    // Tracked-only: the accept-latest-wins CTE + the drops-only, banded predicate.
    expect(text).toContain("tracked AS");
    expect(text).toContain("= 'accept'");
    expect(text).toContain("d.new_price < d.prev_price");
    expect(params).toEqual([7, "2026-08-04T00:00:00.000Z", 0.01, 0.6, 25]);

    expect(out).toEqual([
      { propertyId: 9, zone: "Triana", source: "idealista", url: "https://x/9", oldPrice: 300000, newPrice: 274200, dropPct: (300000 - 274200) / 300000, observedAt: "2026-08-04T12:00:00Z" },
    ]);
  });
});

describe("loadSeguimientoStatusChanges", () => {
  it("restricts to tracked sold/withdrawn events and maps rows", async () => {
    sql.mockResolvedValue([
      { property_id: 4, address: "Retiro", source: "fotocasa", url: null, status: "withdrawn", observed_at: "2026-08-04T11:00:00Z" },
    ]);
    const out = await loadSeguimientoStatusChanges(7, "2026-08-04T00:00:00.000Z", 25);
    const [text, params] = sql.mock.calls[0];
    expect(text).toContain("tracked AS");
    expect(text).toContain("e.status IN ('sold', 'withdrawn')");
    expect(params).toEqual([7, "2026-08-04T00:00:00.000Z", 25]);
    expect(out[0]).toEqual({ propertyId: 4, zone: "Retiro", source: "fotocasa", url: null, status: "withdrawn", observedAt: "2026-08-04T11:00:00Z" });
  });
});

describe("countSeguimientoRecentDrops", () => {
  it("returns the COUNT and passes the same band predicate", async () => {
    sql.mockResolvedValue([{ n: "3" }]);
    const n = await countSeguimientoRecentDrops(7, "2026-08-01T00:00:00.000Z", { minFrac: 0.01, maxFrac: 0.6 });
    expect(n).toBe(3);
    const [text, params] = sql.mock.calls[0];
    expect(text).toContain("COUNT(DISTINCT l.property_id)");
    expect(text).toContain("tracked AS");
    expect(params).toEqual([7, "2026-08-01T00:00:00.000Z", 0.01, 0.6]);
  });

  it("returns 0 when the query yields no rows", async () => {
    sql.mockResolvedValue([]);
    expect(await countSeguimientoRecentDrops(7, "x", { minFrac: 0.01, maxFrac: 0.6 })).toBe(0);
  });
});

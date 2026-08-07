/**
 * Digest content builder — unit tests (issue #35, Phase 5.5 v1).
 *
 * Covers the pure selection/ranking logic (`rankNewCandidates`,
 * `isDigestEmpty`, `digestItemCount`) and the DB-backed `buildDigestForProfile`
 * with `@/lib/db-write` and the area-price comparison mocked, so the assembly
 * (anchor resolution, the three item types, badge enrichment, ranking) is
 * exercised without a live Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sql = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>();
vi.mock("@/lib/db-write", () => ({ sql: (t: string, p?: unknown[]) => sql(t, p) }));

const computeAreaPriceComparison = vi.fn(async (_id: number) => null as unknown);
vi.mock("@/lib/analytics/area-price", () => ({
  computeAreaPriceComparison: (id: number) => computeAreaPriceComparison(id),
}));

// #428 (EC-4): computeRelistedLower is exercised by its own unit tests; here we
// stub it so buildDigestForProfile's wiring (candidate scan → per-property call
// → item mapping) can be asserted without the real cross-listing query.
const computeRelistedLower = vi.fn(async (_id: number) => null as unknown);
vi.mock("@/lib/analytics/market-signals", () => ({
  computeRelistedLower: (id: number) => computeRelistedLower(id),
}));

import {
  rankNewCandidates,
  isDigestEmpty,
  digestItemCount,
  buildDigestForProfile,
  type DigestNewCandidate,
  type DigestContent,
} from "../digest";

function candidate(overrides: Partial<DigestNewCandidate> = {}): DigestNewCandidate {
  return {
    propertyId: 1,
    zone: "Centro",
    propertyType: "piso",
    price: 100000,
    m2: 80,
    pricePerM2: 1250,
    sources: ["idealista"],
    url: "https://x/1",
    score: 0.5,
    scoreKind: "trained",
    flags: [],
    redFlags: [],
    belowMarketPct: null,
    ...overrides,
  };
}

function emptyContent(): DigestContent {
  return {
    profileId: 1,
    profileName: "P",
    since: "2026-08-01T00:00:00.000Z",
    generatedAt: "2026-08-05T07:00:00.000Z",
    seguimientoDrops: [],
    newCandidates: [],
    priceDrops: [],
    statusChanges: [],
    relistedLower: [],
  };
}

describe("rankNewCandidates", () => {
  it("orders by below-market discount first (largest first, nulls last)", () => {
    const items = [
      candidate({ propertyId: 1, belowMarketPct: null }),
      candidate({ propertyId: 2, belowMarketPct: 0.3 }),
      candidate({ propertyId: 3, belowMarketPct: 0.1 }),
    ];
    expect(rankNewCandidates(items).map((c) => c.propertyId)).toEqual([2, 3, 1]);
  });

  it("breaks ties on red-flag count, then score, then id", () => {
    const items = [
      candidate({ propertyId: 10, belowMarketPct: null, redFlags: [], score: 0.9 }),
      candidate({ propertyId: 11, belowMarketPct: null, redFlags: ["Embargo"], score: 0.1 }),
      candidate({ propertyId: 12, belowMarketPct: null, redFlags: ["Embargo"], score: 0.8 }),
    ];
    // 11 & 12 both have a red-flag → ahead of 10; between them, higher score (12) wins.
    expect(rankNewCandidates(items).map((c) => c.propertyId)).toEqual([12, 11, 10]);
  });

  it("is pure — does not mutate its input", () => {
    const items = [candidate({ propertyId: 1 }), candidate({ propertyId: 2, belowMarketPct: 0.5 })];
    const before = items.map((c) => c.propertyId);
    rankNewCandidates(items);
    expect(items.map((c) => c.propertyId)).toEqual(before);
  });
});

describe("isDigestEmpty / digestItemCount", () => {
  it("an all-empty digest is empty and counts zero", () => {
    const c = emptyContent();
    expect(isDigestEmpty(c)).toBe(true);
    expect(digestItemCount(c)).toBe(0);
  });

  it("any single populated section makes it non-empty", () => {
    const c = { ...emptyContent(), statusChanges: [{ propertyId: 1, zone: null, source: "x", url: null, status: "sold" as const, observedAt: "t" }] };
    expect(isDigestEmpty(c)).toBe(false);
    expect(digestItemCount(c)).toBe(1);
  });
});

describe("buildDigestForProfile", () => {
  beforeEach(() => {
    sql.mockReset();
    computeAreaPriceComparison.mockReset();
    computeAreaPriceComparison.mockResolvedValue(null);
    computeRelistedLower.mockReset();
    computeRelistedLower.mockResolvedValue(null);
  });

  function wireSql(rows: {
    anchor?: string;
    candidates?: unknown[];
    flags?: unknown[];
    redflags?: unknown[];
    drops?: unknown[];
    status?: unknown[];
    /** #428 seguimiento (tracked-only) price drops section. */
    seguimientoDrops?: unknown[];
    /** #428 (EC-4) matched properties with a recent withdrawal (relist-candidate scan). */
    relistCandidates?: unknown[];
  }) {
    sql.mockImplementation(async (text: string) => {
      if (text.includes("AS anchor")) return [{ anchor: rows.anchor ?? "2026-08-04T00:00:00.000Z" }];
      if (text.includes("FROM profile_listing_state pls") && text.includes("p.created_at >="))
        return rows.candidates ?? [];
      if (text.includes("assessment_type IN ('occupancy', 'condition')")) return rows.flags ?? [];
      if (text.includes("assessment_type = 'redflags'")) return rows.redflags ?? [];
      // #428 seguimiento drops — WITH tracked AS (...), drops AS (...). Checked
      // before the generic matched-drops branch (which is `WITH drops AS`).
      if (text.includes("tracked AS")) return rows.seguimientoDrops ?? [];
      if (text.includes("WITH drops AS")) return rows.drops ?? [];
      // #428 (EC-4) relist-candidate scan — distinguished from the generic
      // status-change query by its withdrawn/expired predicate.
      if (text.includes("status IN ('withdrawn', 'expired')")) return rows.relistCandidates ?? [];
      if (text.includes("FROM listing_status_event")) return rows.status ?? [];
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    });
  }

  it("resolves the anchor when none is supplied, and passes it to every section query", async () => {
    wireSql({ anchor: "2026-08-04T00:00:00.000Z" });
    const content = await buildDigestForProfile({ id: 7, name: "Madrid" });
    expect(content.since).toBe("2026-08-04T00:00:00.000Z");
    // resolveDigestAnchor + 3 section queries at minimum (new-candidates has 0 rows so no flag/redflag/area queries).
    const texts = sql.mock.calls.map((c) => c[0] as string);
    expect(texts.some((t) => t.includes("AS anchor"))).toBe(true);
    expect(texts.some((t) => t.includes("WITH drops AS"))).toBe(true);
    expect(texts.some((t) => t.includes("FROM listing_status_event"))).toBe(true);
  });

  it("assembles and ranks new candidates, enriching badges + below-market discount", async () => {
    wireSql({
      candidates: [
        { property_id: 1, address: "Centro", property_type: "piso", min_price: "100000", m2_built: "80", sources: ["idealista"], url: "https://x/1", score: "0.4", score_kind: "trained" },
        { property_id: 2, address: "Salamanca", property_type: "piso", min_price: "200000", m2_built: "100", sources: ["fotocasa"], url: "https://x/2", score: "0.9", score_kind: "trained" },
      ],
      flags: [],
      redflags: [{ property_id: 1, result: { flags: [{ type: "embargo" }] } }],
    });
    // Property 1 is 20% below market; property 2 has no comparison.
    computeAreaPriceComparison.mockImplementation(async (id: number) =>
      id === 1 ? { pct_vs_average: -0.2, area_median_price_per_m2: 1500, property_price_per_m2: 1200, sample_size: 10 } : null,
    );

    const content = await buildDigestForProfile({ id: 7, name: "Madrid" }, { since: "2026-08-04T00:00:00.000Z" });
    // Property 1 wins the ranking on below-market discount despite lower score.
    expect(content.newCandidates.map((c) => c.propertyId)).toEqual([1, 2]);
    const c1 = content.newCandidates[0];
    expect(c1.belowMarketPct).toBeCloseTo(0.2);
    expect(c1.redFlags).toEqual(["Embargo"]);
    expect(c1.pricePerM2).toBeCloseTo(1250);
  });

  it("degrades gracefully when the area-price comparison throws", async () => {
    wireSql({
      candidates: [
        { property_id: 1, address: null, property_type: null, min_price: null, m2_built: null, sources: null, url: null, score: null, score_kind: null },
      ],
    });
    computeAreaPriceComparison.mockRejectedValue(new Error("boom"));
    const content = await buildDigestForProfile({ id: 1, name: "P" }, { since: "2026-08-04T00:00:00.000Z" });
    expect(content.newCandidates[0].belowMarketPct).toBeNull();
    expect(content.newCandidates[0].sources).toEqual([]);
  });

  it("maps price drops and status changes into their own sections", async () => {
    wireSql({
      drops: [{ property_id: 3, address: "Centro", source: "idealista", url: "https://x/3", old_price: "250000", new_price: "225000", observed_at: "2026-08-04T10:00:00Z" }],
      status: [{ property_id: 4, address: "Retiro", source: "fotocasa", url: null, status: "withdrawn", observed_at: "2026-08-04T11:00:00Z" }],
    });
    const content = await buildDigestForProfile({ id: 1, name: "P" }, { since: "2026-08-04T00:00:00.000Z" });
    expect(content.priceDrops).toHaveLength(1);
    expect(content.priceDrops[0].dropPct).toBeCloseTo(0.1);
    expect(content.statusChanges[0].status).toBe("withdrawn");
  });

  it("#428: builds the top-placed 'En seguimiento' (tracked-only) drops section, banded in SQL", async () => {
    wireSql({
      seguimientoDrops: [
        { property_id: 9, address: "Triana", source: "idealista", url: "https://x/9", old_price: "300000", new_price: "274200", observed_at: "2026-08-04T12:00:00Z" },
      ],
    });
    const content = await buildDigestForProfile(
      { id: 1, name: "P" },
      { since: "2026-08-04T00:00:00.000Z", band: { minFrac: 0.01, maxFrac: 0.6 } },
    );
    expect(content.seguimientoDrops).toHaveLength(1);
    expect(content.seguimientoDrops[0].propertyId).toBe(9);
    expect(content.seguimientoDrops[0].dropPct).toBeCloseTo(0.086, 2);
    // The band fractions are passed as bound params to the tracked-drops query,
    // so the drops-only + sanity-band filter runs in SQL (not re-derived in TS).
    const call = sql.mock.calls.find((c) => (c[0] as string).includes("tracked AS"));
    expect(call).toBeDefined();
    expect(call![1]).toEqual([1, "2026-08-04T00:00:00.000Z", 0.01, 0.6, 25]);
  });

  it("#428 (EC-4): wires computeRelistedLower for matched properties with a recent withdrawal", async () => {
    wireSql({
      relistCandidates: [
        { property_id: 21, address: "Nervión" },
        { property_id: 22, address: "Los Remedios" },
      ],
    });
    computeRelistedLower.mockImplementation(async (id: number) =>
      id === 21
        ? { withdrawn_at: "2026-07-01T00:00:00Z", withdrawn_price: 200000, relisted_at: "2026-07-20T00:00:00Z", relisted_price: 170000, drop_pct: 0.15 }
        : null,
    );
    const content = await buildDigestForProfile({ id: 1, name: "P" }, { since: "2026-08-04T00:00:00.000Z" });
    // Only property 21 produced a relisted-lower event; 22 returned null.
    expect(content.relistedLower).toHaveLength(1);
    expect(content.relistedLower[0].propertyId).toBe(21);
    expect(content.relistedLower[0].dropPct).toBeCloseTo(0.15);
    expect(content.relistedLower[0].withdrawnPrice).toBe(200000);
    expect(content.relistedLower[0].relistedPrice).toBe(170000);
    expect(computeRelistedLower).toHaveBeenCalledTimes(2);
  });

  it("#428 (EC-4): a per-property computeRelistedLower failure is skipped, not fatal", async () => {
    wireSql({ relistCandidates: [{ property_id: 30, address: "X" }, { property_id: 31, address: "Y" }] });
    computeRelistedLower.mockImplementation(async (id: number) => {
      if (id === 30) throw new Error("boom");
      return { withdrawn_at: "a", withdrawn_price: 100000, relisted_at: "b", relisted_price: 80000, drop_pct: 0.2 };
    });
    const content = await buildDigestForProfile({ id: 1, name: "P" }, { since: "2026-08-04T00:00:00.000Z" });
    expect(content.relistedLower).toHaveLength(1);
    expect(content.relistedLower[0].propertyId).toBe(31);
  });
});

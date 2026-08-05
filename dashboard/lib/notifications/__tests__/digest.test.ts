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
    newCandidates: [],
    priceDrops: [],
    statusChanges: [],
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
  });

  function wireSql(rows: {
    anchor?: string;
    candidates?: unknown[];
    flags?: unknown[];
    redflags?: unknown[];
    drops?: unknown[];
    status?: unknown[];
  }) {
    sql.mockImplementation(async (text: string) => {
      if (text.includes("AS anchor")) return [{ anchor: rows.anchor ?? "2026-08-04T00:00:00.000Z" }];
      if (text.includes("FROM profile_listing_state pls") && text.includes("p.created_at >="))
        return rows.candidates ?? [];
      if (text.includes("assessment_type IN ('occupancy', 'condition')")) return rows.flags ?? [];
      if (text.includes("assessment_type = 'redflags'")) return rows.redflags ?? [];
      if (text.includes("WITH drops AS")) return rows.drops ?? [];
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
});

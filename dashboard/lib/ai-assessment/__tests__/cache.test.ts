/**
 * Shared assessment cache/invalidation — unit tests (#30).
 *
 * Mocks @/lib/db-write so no live DB is needed — this exercises `getOrCompute`
 * and `computeAssessmentContentHash` in isolation, with `computeFn`/`save`
 * passed in as spies. The real-Postgres round trip (a genuine INSERT/SELECT
 * against `ai_assessment.content_hash`) lives in cache.integration.test.ts.
 *
 * The three test names below are exactly what issue #30 names as its three
 * acceptance criteria's `*Verified by*`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
// getOrCompute now wraps its check-compute-save cycle in a Postgres advisory
// lock (#30 review, stampede fix) via a DEDICATED client from `getPool()` —
// separate from `sql()`'s pool.query() path. This module has no real DB, so
// `getPool().connect()` is mocked to return a stub client whose `query()`
// (the `pg_advisory_lock`/`_unlock` calls) resolves immediately: these tests
// are about the cache decision logic, not about the lock itself (that's
// cache.integration.test.ts's job, since an advisory lock is a genuine
// Postgres feature no mock can meaningfully fake).
const mockClientQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
vi.mock("@/lib/db-write", () => ({
  sql: (...a: unknown[]) => mockSql(...a),
  getPool: () => ({ connect: mockConnect }),
}));

import { getOrCompute, getLatestAssessment, computeAssessmentContentHash } from "../cache";
import type { ListingSnapshot } from "@/lib/llm-context";

function row(overrides: Record<string, unknown> = {}) {
  return {
    result: { verdict: "ok" },
    model: "test-model",
    generated_at: "2026-01-01T00:00:00Z",
    prompt_version: "v1",
    content_hash: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockSql.mockReset();
  mockClientQuery.mockClear();
  mockRelease.mockClear();
  mockConnect.mockClear();
});

describe("computeAssessmentContentHash", () => {
  it("changes when a listing's description changes", () => {
    const a: ListingSnapshot[] = [{ listingId: 1, description: "original text" }];
    const b: ListingSnapshot[] = [{ listingId: 1, description: "changed text" }];
    expect(computeAssessmentContentHash(a)).not.toBe(computeAssessmentContentHash(b));
  });

  it("changes when a new listing joins the property (what a dedup merge IS)", () => {
    const before: ListingSnapshot[] = [{ listingId: 1, description: "a" }];
    const afterMerge: ListingSnapshot[] = [
      { listingId: 1, description: "a" },
      { listingId: 2, description: "b" },
    ];
    expect(computeAssessmentContentHash(before)).not.toBe(
      computeAssessmentContentHash(afterMerge),
    );
  });

  it("is independent of listing order (loadPropertyListings' newest-first order must not matter to the hash)", () => {
    const orderA: ListingSnapshot[] = [
      { listingId: 1, description: "a" },
      { listingId: 2, description: "b" },
    ];
    const orderB: ListingSnapshot[] = [
      { listingId: 2, description: "b" },
      { listingId: 1, description: "a" },
    ];
    expect(computeAssessmentContentHash(orderA)).toBe(computeAssessmentContentHash(orderB));
  });

  it("does NOT change when only price changes — price is not part of the hash at all", () => {
    const a: ListingSnapshot[] = [{ listingId: 1, description: "a", price: 100000 }];
    const b: ListingSnapshot[] = [{ listingId: 1, description: "a", price: 999999 }];
    expect(computeAssessmentContentHash(a)).toBe(computeAssessmentContentHash(b));
  });
});

describe("getLatestAssessment — stale flag", () => {
  it("marks a row stale when its prompt_version isn't the caller's current version", async () => {
    mockSql.mockResolvedValueOnce([row({ prompt_version: "v1" })]);
    const cached = await getLatestAssessment(1, "condition", "v2");
    expect(cached?.stale).toBe(true);
  });

  it("marks a row fresh when its prompt_version matches", async () => {
    mockSql.mockResolvedValueOnce([row({ prompt_version: "v2" })]);
    const cached = await getLatestAssessment(1, "condition", "v2");
    expect(cached?.stale).toBe(false);
  });

  it("queries latest-per-axis with no prompt_version filter (the #156/#30 DISTINCT ON rule)", async () => {
    mockSql.mockResolvedValueOnce([row()]);
    await getLatestAssessment(1, "condition", "v1");
    const [sqlText, params] = mockSql.mock.calls[0];
    expect(sqlText).toContain("DISTINCT ON (property_id, assessment_type)");
    expect(sqlText).not.toContain("prompt_version = ");
    expect(params).toEqual([1, "condition"]);
  });

  it("returns null when nothing has ever been generated", async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await getLatestAssessment(1, "condition", "v1")).toBeNull();
  });
});

describe("getOrCompute", () => {
  const listings: ListingSnapshot[] = [{ listingId: 1, description: "piso de 90m2" }];
  const hash = computeAssessmentContentHash(listings);

  it('EC-1: "cache hit avoids second LLM call"', async () => {
    // First call: no row on file → miss → computeFn runs, save persists.
    mockSql.mockResolvedValueOnce([]);
    const computeFn = vi.fn().mockResolvedValue({ result: { v: 1 }, model: "m1" });
    const save = vi.fn().mockResolvedValue(undefined);

    const first = await getOrCompute(1, "condition", "v1", listings, computeFn, save);
    expect(first.fromCache).toBe(false);
    expect(computeFn).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, { v: 1 }, "m1", hash);

    // Second call for the SAME unchanged listings: the row `save` would have
    // written now comes back from the (mocked) DB → hit, computeFn NOT called again.
    mockSql.mockResolvedValueOnce([
      row({ result: { v: 1 }, model: "m1", prompt_version: "v1", content_hash: hash }),
    ]);
    const second = await getOrCompute(1, "condition", "v1", listings, computeFn, save);
    expect(second.fromCache).toBe(true);
    expect(computeFn).toHaveBeenCalledTimes(1); // still 1 — this is the whole point of #30
  });

  it('EC-2: "prompt version bump invalidates cache"', async () => {
    // A row exists, but generated under v1 — caller now asks for v2.
    mockSql.mockResolvedValueOnce([
      row({ prompt_version: "v1", content_hash: hash }),
    ]);
    const computeFn = vi.fn().mockResolvedValue({ result: { v: 2 }, model: "m2" });
    const save = vi.fn().mockResolvedValue(undefined);

    const result = await getOrCompute(1, "condition", "v2", listings, computeFn, save);
    expect(result.fromCache).toBe(false);
    expect(computeFn).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, { v: 2 }, "m2", hash);
  });

  it('EC-3: "content-hash invalidation is field-scoped" — description change misses, price-only change hits', async () => {
    const original: ListingSnapshot[] = [{ listingId: 1, description: "original desc" }];
    const originalHash = computeAssessmentContentHash(original);

    // A connector update that ONLY changes price: listing payload carries a
    // different price but the SAME description/id → hash unchanged → HIT.
    const priceChangedOnly: ListingSnapshot[] = [
      { listingId: 1, description: "original desc", price: 555000 },
    ];
    mockSql.mockResolvedValueOnce([
      row({ prompt_version: "v1", content_hash: originalHash }),
    ]);
    const computeFnPrice = vi.fn();
    const savePrice = vi.fn();
    const priceResult = await getOrCompute(
      1,
      "condition",
      "v1",
      priceChangedOnly,
      computeFnPrice,
      savePrice,
    );
    expect(priceResult.fromCache).toBe(true);
    expect(computeFnPrice).not.toHaveBeenCalled();

    // A connector update that changes the description → hash changes → MISS.
    const descriptionChanged: ListingSnapshot[] = [
      { listingId: 1, description: "a reformar, necesita obra" },
    ];
    mockSql.mockResolvedValueOnce([
      row({ prompt_version: "v1", content_hash: originalHash }),
    ]);
    const computeFnDesc = vi.fn().mockResolvedValue({ result: { v: 9 }, model: "m9" });
    const saveDesc = vi.fn().mockResolvedValue(undefined);
    const descResult = await getOrCompute(
      1,
      "condition",
      "v1",
      descriptionChanged,
      computeFnDesc,
      saveDesc,
    );
    expect(descResult.fromCache).toBe(false);
    expect(computeFnDesc).toHaveBeenCalledTimes(1);
  });

  it("treats a pre-existing row with a NULL content_hash as a miss (cannot know what it was computed from)", async () => {
    mockSql.mockResolvedValueOnce([
      row({ prompt_version: "v1", content_hash: null }),
    ]);
    const computeFn = vi.fn().mockResolvedValue({ result: { v: 1 }, model: "m" });
    const save = vi.fn().mockResolvedValue(undefined);

    const result = await getOrCompute(1, "condition", "v1", listings, computeFn, save);
    expect(result.fromCache).toBe(false);
    expect(computeFn).toHaveBeenCalledTimes(1);
  });

  it("acquires and releases the advisory lock keyed on (propertyId, assessmentType), then releases the client back (#30 review, stampede fix)", async () => {
    mockSql.mockResolvedValueOnce([]);
    const computeFn = vi.fn().mockResolvedValue({ result: { v: 1 }, model: "m1" });
    const save = vi.fn().mockResolvedValue(undefined);

    await getOrCompute(7, "redflags", "v1", listings, computeFn, save);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(2); // lock, then unlock
    const [lockSql, lockParams] = mockClientQuery.mock.calls[0];
    const [unlockSql, unlockParams] = mockClientQuery.mock.calls[1];
    expect(lockSql).toContain("pg_advisory_lock");
    expect(unlockSql).toContain("pg_advisory_unlock");
    // Same key material passed to both, so lock and unlock hash identically.
    expect(lockParams).toEqual(unlockParams);
    expect(lockParams[0]).toContain("7");
    expect(lockParams[0]).toContain("redflags");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

/**
 * `assessPropertyOccupancy`'s #184 wiring — unit test, fully mocked.
 *
 * The cache-primitive-level agreement (`computeAssessmentContentHash`/
 * `getOrCompute`) is proven in cache.test.ts and
 * price-signal-hash-agreement.test.ts. What those tests CANNOT catch is a
 * wiring bug at the call site: `assessPropertyOccupancy` could compute
 * `areaPriceSignal` correctly and still pass a DIFFERENT value (or none) to
 * `getOrCompute`'s `extraHashInput` than it passes into `assessOccupancy`'s
 * `opts.areaPriceSignal` — the exact shape of bug #180 was (rendered X,
 * hashed Y), just moved one layer up. This test asserts the real
 * `assessPropertyOccupancy` source, with `buildAreaPriceSignal`,
 * `assessOccupancy`, and `getOrCompute` all mocked so the ONE thing under
 * test is which value flows into each.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadPropertyListings = vi.fn();
vi.mock("@/lib/ai-assessment/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared")>();
  return {
    ...actual,
    loadPropertyListings: (...a: unknown[]) => mockLoadPropertyListings(...a),
  };
});

const mockBuildAreaPriceSignal = vi.fn();
vi.mock("@/lib/ai-assessment/price-signal", () => ({
  buildAreaPriceSignal: (...a: unknown[]) => mockBuildAreaPriceSignal(...a),
}));

const mockAssessOccupancy = vi.fn();
vi.mock("@/lib/llm", () => ({
  assessOccupancy: (...a: unknown[]) => mockAssessOccupancy(...a),
}));

const mockGetOrCompute = vi.fn();
const mockGetLatestAssessment = vi.fn();
const mockLogCacheOutcome = vi.fn();
vi.mock("@/lib/ai-assessment/cache", () => ({
  getOrCompute: (...a: unknown[]) => mockGetOrCompute(...a),
  getLatestAssessment: (...a: unknown[]) => mockGetLatestAssessment(...a),
  logCacheOutcome: (...a: unknown[]) => mockLogCacheOutcome(...a),
}));

vi.mock("@/lib/db-write", () => ({ sql: vi.fn() }));

import { assessPropertyOccupancy } from "../occupancy";

const LISTINGS = [{ propertyId: 1, listingId: 10, description: "piso de 90m2" }];

beforeEach(() => {
  mockLoadPropertyListings.mockReset().mockResolvedValue(LISTINGS);
  mockAssessOccupancy.mockReset().mockResolvedValue({ text: "{}", model: "m" });
  mockGetOrCompute.mockReset();
  mockGetLatestAssessment.mockReset();
  mockLogCacheOutcome.mockReset();
});

describe("assessPropertyOccupancy — #184 hash/prompt agreement at the call site", () => {
  it("passes the EXACT SAME areaPriceSignal into assessOccupancy's opts AND getOrCompute's extraHashInput", async () => {
    const SIGNAL = "El precio de este inmueble está aproximadamente un 20-30% por debajo...";
    mockBuildAreaPriceSignal.mockResolvedValueOnce(SIGNAL);
    mockGetOrCompute.mockImplementationOnce(async (_pid, _type, _ver, _listings, computeFn) => {
      // Run computeFn so assessOccupancy is actually invoked with the
      // signal, exactly like the real getOrCompute does on a miss.
      const { result, model } = await computeFn();
      return { result, model, fromCache: false };
    });

    await assessPropertyOccupancy(1);

    expect(mockAssessOccupancy).toHaveBeenCalledTimes(1);
    const [, assessOpts] = mockAssessOccupancy.mock.calls[0];
    expect(assessOpts.areaPriceSignal).toBe(SIGNAL);

    // getOrCompute is called as getOrCompute(propertyId, type, version, listings, computeFn, save, extraHashInput).
    const getOrComputeArgs = mockGetOrCompute.mock.calls[0];
    const extraHashInput = getOrComputeArgs[6];
    expect(extraHashInput).toBe(SIGNAL);

    // The two must be the SAME value, not just both truthy.
    expect(assessOpts.areaPriceSignal).toBe(extraHashInput);
  });

  it("when buildAreaPriceSignal returns undefined, BOTH the prompt opts and the hash input are undefined (no lopsided default)", async () => {
    mockBuildAreaPriceSignal.mockResolvedValueOnce(undefined);
    mockGetOrCompute.mockImplementationOnce(async (_pid, _type, _ver, _listings, computeFn) => {
      const { result, model } = await computeFn();
      return { result, model, fromCache: false };
    });

    await assessPropertyOccupancy(1);

    const [, assessOpts] = mockAssessOccupancy.mock.calls[0];
    const extraHashInput = mockGetOrCompute.mock.calls[0][6];
    expect(assessOpts.areaPriceSignal).toBeUndefined();
    expect(extraHashInput).toBeUndefined();
  });
});

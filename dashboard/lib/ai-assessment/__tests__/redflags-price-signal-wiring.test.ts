/**
 * `assessPropertyRedFlags`'s #184 wiring — unit test, fully mocked.
 * Mirrors occupancy-price-signal-wiring.test.ts — see its header for why
 * this call-site-level check is needed on top of the cache-primitive-level
 * tests (cache.test.ts / price-signal-hash-agreement.test.ts).
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

const mockExtractRedFlags = vi.fn();
vi.mock("@/lib/llm", () => ({
  extractRedFlags: (...a: unknown[]) => mockExtractRedFlags(...a),
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

import { assessPropertyRedFlags } from "../redflags";

const LISTINGS = [{ propertyId: 1, listingId: 10, description: "piso de 90m2" }];

beforeEach(() => {
  mockLoadPropertyListings.mockReset().mockResolvedValue(LISTINGS);
  mockExtractRedFlags.mockReset().mockResolvedValue({ text: '{"flags":[],"confidence":0.5}', model: "m" });
  mockGetOrCompute.mockReset();
  mockGetLatestAssessment.mockReset();
  mockLogCacheOutcome.mockReset();
});

describe("assessPropertyRedFlags — #184 hash/prompt agreement at the call site", () => {
  it("passes the EXACT SAME areaPriceSignal into extractRedFlags's opts AND getOrCompute's extraHashInput", async () => {
    const SIGNAL = "El precio de este inmueble está aproximadamente un 30-40% por debajo...";
    mockBuildAreaPriceSignal.mockResolvedValueOnce(SIGNAL);
    mockGetOrCompute.mockImplementationOnce(async (_pid, _type, _ver, _listings, computeFn) => {
      const { result, model } = await computeFn();
      return { result, model, fromCache: false };
    });

    await assessPropertyRedFlags(1);

    expect(mockExtractRedFlags).toHaveBeenCalledTimes(1);
    const [, assessOpts] = mockExtractRedFlags.mock.calls[0];
    expect(assessOpts.areaPriceSignal).toBe(SIGNAL);

    const extraHashInput = mockGetOrCompute.mock.calls[0][6];
    expect(extraHashInput).toBe(SIGNAL);
    expect(assessOpts.areaPriceSignal).toBe(extraHashInput);
  });

  it("when buildAreaPriceSignal returns undefined, BOTH the prompt opts and the hash input are undefined", async () => {
    mockBuildAreaPriceSignal.mockResolvedValueOnce(undefined);
    mockGetOrCompute.mockImplementationOnce(async (_pid, _type, _ver, _listings, computeFn) => {
      const { result, model } = await computeFn();
      return { result, model, fromCache: false };
    });

    await assessPropertyRedFlags(1);

    const [, assessOpts] = mockExtractRedFlags.mock.calls[0];
    const extraHashInput = mockGetOrCompute.mock.calls[0][6];
    expect(assessOpts.areaPriceSignal).toBeUndefined();
    expect(extraHashInput).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/system-config/loader", () => ({ getSystemConfig: vi.fn() }));

import { getStalenessConfig } from "@/lib/captura-staleness-config";
import * as loader from "@/lib/system-config/loader";
import { DEFAULT_STALENESS_DAYS } from "@/lib/captura-tasks";

const mockGet = vi.mocked(loader.getSystemConfig);

// Minimal ConfigValue-shaped stub — only `.value` is read.
function cv(value: unknown) {
  return { value } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("getStalenessConfig", () => {
  it("reads the global default and per-portal overrides", () => {
    mockGet.mockReturnValue({
      "capture.staleness_days": cv(10),
      "capture.staleness_days_idealista": cv(3),
      "capture.staleness_days_aliseda": cv(null),
    } as never);
    const out = getStalenessConfig();
    expect(out.defaultDays).toBe(10);
    expect(out.byPortal).toEqual({ idealista: 3 });
  });

  it("falls back to the hardcoded default when the global is unset", () => {
    mockGet.mockReturnValue({} as never);
    const out = getStalenessConfig();
    expect(out.defaultDays).toBe(DEFAULT_STALENESS_DAYS);
    expect(out.byPortal).toEqual({});
  });

  it("ignores non-positive / non-integer values", () => {
    mockGet.mockReturnValue({
      "capture.staleness_days": cv(0),
      "capture.staleness_days_idealista": cv(-2),
      "capture.staleness_days_aliseda": cv("abc"),
    } as never);
    const out = getStalenessConfig();
    expect(out.defaultDays).toBe(DEFAULT_STALENESS_DAYS);
    expect(out.byPortal).toEqual({});
  });

  it("coerces a numeric string override", () => {
    mockGet.mockReturnValue({
      "capture.staleness_days": cv("14"),
      "capture.staleness_days_aliseda": cv("5"),
    } as never);
    const out = getStalenessConfig();
    expect(out.defaultDays).toBe(14);
    expect(out.byPortal).toEqual({ aliseda: 5 });
  });

  it("falls back gracefully when the loader throws", () => {
    mockGet.mockImplementation(() => {
      throw new Error("no schema");
    });
    const out = getStalenessConfig();
    expect(out.defaultDays).toBe(DEFAULT_STALENESS_DAYS);
    expect(out.byPortal).toEqual({});
  });
});

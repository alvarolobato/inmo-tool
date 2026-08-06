/**
 * Unit tests for the freshness-cadence derivation helpers (issue #295, D-050) —
 * pure functions, no DB. They mirror the ETL's `_freshness_decision` /
 * `_finalize_connector_freshness_cycle` state model so the dashboard shows the
 * same fresh / refreshing / stuck / due states the orchestrator acts on.
 */
import { describe, it, expect, vi } from "vitest";

// db-shared registers an int8 type parser against `pg` at import time; a
// minimal mock keeps importing the module (via db-write) side-effect free.
vi.mock("pg", () => ({
  Pool: class {
    query = vi.fn();
    end = vi.fn();
  },
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import { deriveFreshnessState, resolveFreshnessInterval } from "@/lib/db/connectors";

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
const iso = (ago: number) => new Date(NOW - ago).toISOString();

describe("resolveFreshnessInterval", () => {
  it("uses the global default when the override is null/invalid", () => {
    expect(resolveFreshnessInterval(null, 24)).toEqual({
      intervalHours: null,
      effectiveIntervalHours: 24,
    });
    // NULL means "use the default", never "disable tracking".
    expect(resolveFreshnessInterval(0, 24).effectiveIntervalHours).toBe(24);
    expect(resolveFreshnessInterval(-5, 24).effectiveIntervalHours).toBe(24);
    expect(resolveFreshnessInterval(1.5, 24).effectiveIntervalHours).toBe(24);
    expect(resolveFreshnessInterval(true, 24).effectiveIntervalHours).toBe(24);
  });

  it("honours a valid positive integer override", () => {
    expect(resolveFreshnessInterval(6, 24)).toEqual({
      intervalHours: 6,
      effectiveIntervalHours: 6,
    });
    // Numeric strings coerce, matching the read-side tolerance elsewhere.
    expect(resolveFreshnessInterval("48", 24)).toEqual({
      intervalHours: 48,
      effectiveIntervalHours: 48,
    });
  });
});

function derive(over: {
  intervalHoursOverrideRaw?: unknown;
  lastFreshAt?: string | null;
  cycleStartedAt?: string | null;
  targetScopeCount?: number | null;
  coveredScopeCount?: number | null;
  defaultIntervalHours?: number;
  stuckAfterHours?: number;
}) {
  return deriveFreshnessState({
    intervalHoursOverrideRaw: over.intervalHoursOverrideRaw ?? null,
    lastFreshAt: over.lastFreshAt ?? null,
    cycleStartedAt: over.cycleStartedAt ?? null,
    targetScopeCount: over.targetScopeCount ?? null,
    coveredScopeCount: over.coveredScopeCount ?? null,
    defaultIntervalHours: over.defaultIntervalHours ?? 24,
    stuckAfterHours: over.stuckAfterHours ?? 168,
    nowMs: NOW,
  });
}

describe("deriveFreshnessState", () => {
  it("never fresh, no cycle → due", () => {
    expect(derive({}).kind).toBe("due");
  });

  it("fresh inside the interval → fresh", () => {
    expect(derive({ lastFreshAt: iso(1 * HOUR) }).kind).toBe("fresh");
  });

  it("fresh but past the interval → due", () => {
    expect(derive({ lastFreshAt: iso(30 * HOUR) }).kind).toBe("due");
  });

  it("a per-connector override changes when 'due' triggers", () => {
    // 6h override, last fresh 8h ago → past its own interval → due (even though
    // it would still be fresh at the 24h default).
    expect(
      derive({ intervalHoursOverrideRaw: 6, lastFreshAt: iso(8 * HOUR) }).kind,
    ).toBe("due");
    expect(
      derive({ intervalHoursOverrideRaw: 6, lastFreshAt: iso(8 * HOUR) })
        .effectiveIntervalHours,
    ).toBe(6);
  });

  it("cycle in progress within the stuck horizon → refreshing (with N/M counts)", () => {
    const s = derive({
      cycleStartedAt: iso(2 * HOUR),
      targetScopeCount: 4,
      coveredScopeCount: 1,
    });
    expect(s.kind).toBe("refreshing");
    expect(s.targetScopeCount).toBe(4);
    expect(s.coveredScopeCount).toBe(1);
  });

  it("cycle in progress past the stuck horizon → stuck", () => {
    expect(
      derive({ cycleStartedAt: iso(200 * HOUR), stuckAfterHours: 168 }).kind,
    ).toBe("stuck");
  });

  it("a cycle in progress always wins over the interval (continue, never abandon)", () => {
    // Even with a very fresh last_fresh_at, an in-progress cycle reads as
    // refreshing — the interval only gates STARTING a cycle.
    expect(
      derive({ lastFreshAt: iso(0), cycleStartedAt: iso(1 * HOUR) }).kind,
    ).toBe("refreshing");
  });
});

import { describe, it, expect } from "vitest";
import {
  STALENESS_FRESH_MAX_DAYS,
  STALENESS_AGING_MAX_DAYS,
  stalenessBand,
  computeStaleness,
  freshestActiveLastSeen,
} from "../staleness";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("stalenessBand", () => {
  it("bands by the documented thresholds (fresh ≤ 7, aging ≤ 21, stale beyond)", () => {
    expect(stalenessBand(0)).toBe("fresh");
    expect(stalenessBand(STALENESS_FRESH_MAX_DAYS)).toBe("fresh"); // 7 = still fresh
    expect(stalenessBand(STALENESS_FRESH_MAX_DAYS + 1)).toBe("aging"); // 8
    expect(stalenessBand(STALENESS_AGING_MAX_DAYS)).toBe("aging"); // 21 = still aging
    expect(stalenessBand(STALENESS_AGING_MAX_DAYS + 1)).toBe("stale"); // 22
    expect(stalenessBand(365)).toBe("stale");
  });
});

describe("computeStaleness", () => {
  it("returns null (not 'visto hoy') for an unknown last_seen_at — unknown is not fresh", () => {
    expect(computeStaleness(null, NOW)).toBeNull();
    expect(computeStaleness(undefined, NOW)).toBeNull();
    expect(computeStaleness("not-a-date", NOW)).toBeNull();
  });

  it("labels today/yesterday/N-days and picks the right band", () => {
    expect(computeStaleness(daysBefore(0), NOW)).toEqual({ band: "fresh", days: 0, label: "visto hoy" });
    expect(computeStaleness(daysBefore(1), NOW)).toEqual({ band: "fresh", days: 1, label: "visto ayer" });
    expect(computeStaleness(daysBefore(3), NOW)).toEqual({
      band: "fresh",
      days: 3,
      label: "visto hace 3 días",
    });
    expect(computeStaleness(daysBefore(14), NOW)).toEqual({
      band: "aging",
      days: 14,
      label: "visto hace 14 días",
    });
    expect(computeStaleness(daysBefore(30), NOW)).toEqual({
      band: "stale",
      days: 30,
      label: "visto hace 30 días",
    });
  });

  it("clamps a future last_seen_at (clock skew) to 0 days / fresh rather than a negative age", () => {
    const future = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeStaleness(future, NOW)).toEqual({ band: "fresh", days: 0, label: "visto hoy" });
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(computeStaleness(new Date(daysBefore(2)), NOW)?.days).toBe(2);
  });
});

describe("freshestActiveLastSeen", () => {
  it("returns the MAX last_seen_at across active listings — the freshest, not the oldest (mutation guard)", () => {
    const freshest = freshestActiveLastSeen([
      { status: "active", last_seen_at: daysBefore(30) },
      { status: "active", last_seen_at: daysBefore(2) },
      { status: "active", last_seen_at: daysBefore(10) },
    ]);
    // A MIN/oldest implementation would return the 30-day timestamp.
    expect(freshest).toBe(daysBefore(2));
  });

  it("ignores non-active listings entirely", () => {
    // The freshest overall is the withdrawn one (1 day), but it must be
    // ignored — only the active listing (30 days) counts.
    const freshest = freshestActiveLastSeen([
      { status: "active", last_seen_at: daysBefore(30) },
      { status: "withdrawn", last_seen_at: daysBefore(1) },
      { status: "sold", last_seen_at: daysBefore(1) },
    ]);
    expect(freshest).toBe(daysBefore(30));
  });

  it("skips active listings whose last_seen_at is null", () => {
    const freshest = freshestActiveLastSeen([
      { status: "active", last_seen_at: null },
      { status: "active", last_seen_at: daysBefore(5) },
    ]);
    expect(freshest).toBe(daysBefore(5));
  });

  it("returns null when no active listing has a last_seen_at", () => {
    expect(
      freshestActiveLastSeen([
        { status: "active", last_seen_at: null },
        { status: "withdrawn", last_seen_at: daysBefore(1) },
      ]),
    ).toBeNull();
    expect(freshestActiveLastSeen([])).toBeNull();
  });
});

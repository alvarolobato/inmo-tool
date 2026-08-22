/**
 * Unit tests for the pure queue model (issue #640, EC-3).
 *
 * The derivation is small on purpose, so what these tests are really pinning
 * are its EDGES — the cases where a naive implementation quietly lies:
 * an empty queue that churned all day, a queue with work waiting and zero
 * throughput, and the two "not measured" shapes that must never collapse
 * into a confident zero.
 */
import { describe, it, expect } from "vitest";
import {
  QUEUE_WINDOW_HOURS,
  deriveTrend,
  drainEtaHours,
  formatDepth,
  formatEta,
  sortQueues,
  TREND_LABEL,
  type QueueTile,
} from "../queues";

describe("deriveTrend", () => {
  it("says draining when 24h resolutions exceed 24h creations (EC-3)", () => {
    expect(deriveTrend(287, 46, 90)).toBe("draining");
  });

  it("says growing when creations exceed resolutions", () => {
    expect(deriveTrend(287, 90, 46)).toBe("growing");
  });

  it("says steady when in and out match and both are non-zero", () => {
    expect(deriveTrend(287, 46, 46)).toBe("steady");
  });

  it("says empty at depth 0 regardless of how much flowed through", () => {
    // A queue that took in 500 and cleared 500 is not 'draining' — it is done.
    expect(deriveTrend(0, 500, 500)).toBe("empty");
    expect(deriveTrend(0, 0, 0)).toBe("empty");
  });

  it("says stalled when work is waiting and nothing left in the window", () => {
    expect(deriveTrend(1530, 0, 0)).toBe("stalled");
  });

  it("ranks stalled above growing when both are true", () => {
    // in=100, out=0: technically growing, but 'nothing is being processed' is
    // the more actionable of the two claims — see the QueueTrend doc.
    expect(deriveTrend(100, 100, 0)).toBe("stalled");
  });

  it("says working, not draining, when inflow is unmeasured", () => {
    // The AI-assessment backlog: throughput is known, arrivals are not, so no
    // direction may be claimed.
    expect(deriveTrend(1157, null, 1076)).toBe("working");
  });

  it("still says stalled with an unmeasured inflow and zero throughput", () => {
    expect(deriveTrend(1157, null, 0)).toBe("stalled");
  });

  it("says unknown when depth itself is not evaluable", () => {
    expect(deriveTrend(null, 5, 5)).toBe("unknown");
  });

  it("says unknown when there is a backlog but outflow is unmeasured", () => {
    expect(deriveTrend(3, null, null)).toBe("unknown");
  });

  it("says empty — not unknown — at depth 0 with unmeasured flows", () => {
    expect(deriveTrend(0, null, null)).toBe("empty");
  });

  it("has a label for every trend it can return", () => {
    const all = new Set([
      deriveTrend(null, null, null),
      deriveTrend(0, 0, 0),
      deriveTrend(1, 0, 0),
      deriveTrend(1, 1, 2),
      deriveTrend(1, 2, 1),
      deriveTrend(1, 1, 1),
      deriveTrend(1, null, 1),
    ]);
    expect(all.size).toBe(7);
    for (const t of all) expect(TREND_LABEL[t]).toBeTruthy();
  });
});

describe("drainEtaHours", () => {
  it("scales depth by the observed rate over the window", () => {
    // 100 waiting, 50 cleared per 24h → 48h.
    expect(drainEtaHours(100, 50)).toBeCloseTo(48);
    expect(QUEUE_WINDOW_HOURS).toBe(24);
  });

  it("is null when the rate is zero — an ETA off no throughput is infinity", () => {
    expect(drainEtaHours(100, 0)).toBeNull();
  });

  it("is null when nothing is waiting", () => {
    expect(drainEtaHours(0, 50)).toBeNull();
  });

  it("is null when either side is unmeasured", () => {
    expect(drainEtaHours(null, 50)).toBeNull();
    expect(drainEtaHours(100, null)).toBeNull();
  });
});

describe("formatEta", () => {
  it("renders hours, days and the sub-hour floor", () => {
    expect(formatEta(0.4)).toBe("~<1 h");
    expect(formatEta(3.2)).toBe("~3 h");
    expect(formatEta(72)).toBe("~3 d");
    expect(formatEta(null)).toBeNull();
  });
});

describe("formatDepth", () => {
  it("groups thousands the Spanish way and preserves null", () => {
    // Grouped from four digits up, unlike CLDR es-ES (which starts at five) —
    // see the function's own note on why this is hand-rolled.
    expect(formatDepth(1530)).toBe("1.530");
    expect(formatDepth(13774)).toBe("13.774");
    expect(formatDepth(999)).toBe("999");
    expect(formatDepth(0)).toBe("0");
    // null must survive as null so the surface can render a reason instead of
    // a fabricated zero.
    expect(formatDepth(null)).toBeNull();
  });
});

function tile(key: string, severity: QueueTile["severity"]): QueueTile {
  return {
    key,
    label: key,
    depth: 0,
    headline: null,
    inflow24h: 0,
    outflow24h: 0,
    oldestAgeHours: null,
    trend: "empty",
    severity,
    note: null,
    unmeasured: null,
    href: null,
    etaHours: null,
  };
}

describe("sortQueues", () => {
  it("puts problems first and keeps the canonical order within a severity", () => {
    const sorted = sortQueues([
      tile("a-ok", "ok"),
      tile("b-alarm", "alarm"),
      tile("c-warn", "warn"),
      tile("d-ok", "ok"),
      tile("e-alarm", "alarm"),
    ]);
    expect(sorted.map((t) => t.key)).toEqual([
      "b-alarm",
      "e-alarm",
      "c-warn",
      "a-ok",
      "d-ok",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [tile("a-ok", "ok"), tile("b-alarm", "alarm")];
    sortQueues(input);
    expect(input.map((t) => t.key)).toEqual(["a-ok", "b-alarm"]);
  });
});

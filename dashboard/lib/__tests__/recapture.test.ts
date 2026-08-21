// @vitest-environment node
/**
 * Pure helpers for cohort re-capture (issue #677).
 *
 * The estimate tests are not decoration. The number this module produces is
 * the only thing standing between the owner and accidentally committing to an
 * overnight-scale browsing session: the panel shows it, and the confirm button
 * is armed underneath it. If browser-extension/batch.js's pacing constants
 * move and this module's mirror of them does not, the estimate silently
 * understates the cost of a bulk requeue. So the steady-state figure is
 * asserted against values re-derived by hand from batch.js, not just against
 * whatever this implementation happens to return.
 */
import { describe, it, expect } from "vitest";
import {
  estimateBatchSeconds,
  formatBytes,
  formatDuration,
  isRecapturePredicate,
  RECAPTURE_PREDICATES,
  RECAPTURE_PREDICATE_LABEL,
} from "@/lib/recapture";

describe("isRecapturePredicate", () => {
  it("accepts every declared predicate", () => {
    for (const p of RECAPTURE_PREDICATES) {
      expect(isRecapturePredicate(p)).toBe(true);
    }
  });

  it("rejects anything outside the closed set", () => {
    // The predicate vocabulary is what stops this feature being a SQL console
    // reachable from a browser, so the guard must not be permissive.
    for (const v of [
      "",
      "all",
      "1=1",
      "few_photos; DROP TABLE listing",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isRecapturePredicate(v)).toBe(false);
    }
  });

  it("gives every predicate a label and a threshold spec", () => {
    for (const p of RECAPTURE_PREDICATES) {
      const spec = RECAPTURE_PREDICATE_LABEL[p];
      expect(spec.label.length).toBeGreaterThan(0);
      // A predicate with a unit must supply a default; one without must not.
      expect(spec.unit === null).toBe(spec.defaultThreshold === null);
    }
  });
});

describe("estimateBatchSeconds", () => {
  it("is zero for an empty cohort", () => {
    expect(estimateBatchSeconds(0)).toBe(0);
    expect(estimateBatchSeconds(-5)).toBe(0);
  });

  it("uses the opening cadence for the first pace step", () => {
    // batch.js: base 2000 ms + uniform [0, 5000) → mean 4500 ms, and the base
    // does not step up until 25 pages have settled.
    expect(estimateBatchSeconds(25)).toBe(Math.round((25 * 4500) / 1000));
  });

  it("applies the +2 s-per-25-pages backoff", () => {
    // Pages 1-25 @ 4500 ms, 26-50 @ 6500 ms.
    expect(estimateBatchSeconds(50)).toBe(
      Math.round((25 * 4500 + 25 * 6500) / 1000),
    );
  });

  it("caps the backoff at +12 s, i.e. 16.5 s/listing steady state", () => {
    // The cap lands at page 150 (6 steps of 25). Two cohorts 100 pages apart
    // past the cap must differ by exactly 100 x 16500 ms.
    const a = estimateBatchSeconds(1000);
    const b = estimateBatchSeconds(1100);
    expect(b - a).toBe(Math.round((100 * 16500) / 1000));
  });

  it("puts the real Idealista cohort at overnight scale, not 'a few hours'", () => {
    // 3,258 idealista worklist rows measured in production (issue #677). This
    // is the assertion that would fail loudly if the pacing mirror drifted
    // toward a comfortable-looking under-estimate.
    const seconds = estimateBatchSeconds(3258);
    expect(seconds / 3600).toBeGreaterThan(14);
    expect(seconds / 3600).toBeLessThan(15);
    // …and the value-ordered subset is barely cheaper — 2,800 rows still
    // costs an overnight run, which is the honest framing the panel shows.
    expect(estimateBatchSeconds(2800) / 3600).toBeGreaterThan(12);
  });

  it("is monotonic in the number of pages", () => {
    let prev = -1;
    for (const n of [1, 10, 25, 26, 149, 150, 151, 500, 3258]) {
      const s = estimateBatchSeconds(n);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});

describe("formatDuration", () => {
  it("renders the scales the panel actually shows", () => {
    expect(formatDuration(30)).toBe("unos segundos");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(52707)).toBe("14 h 38 min"); // the 3,258-row cohort
  });
});

describe("formatBytes", () => {
  it("renders storage at the scale a bulk pass reaches", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(436 * 1024)).toBe("436 kB");
    // ~355 MB stored / ~1.4 GB raw is the measured cost of the idealista pass.
    expect(formatBytes(355 * 1024 * 1024)).toBe("355 MB");
    expect(formatBytes(1.4 * 1024 * 1024 * 1024)).toBe("1,4 GB");
  });
});

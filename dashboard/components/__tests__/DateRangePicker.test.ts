import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeComparisonRange,
  detectPeriodType,
  navigatePeriod,
  formatPeriodLabel,
  CURRENT_PRESETS,
  PREVIOUS_PRESETS,
  isoWeekMonday,
  currentQuarterStart,
} from "../DateRangePicker";
import type { DateRange } from "../DateRangePicker";

function d(year: number, month: number, day: number, h = 0, min = 0, sec = 0, ms = 0): Date {
  return new Date(year, month - 1, day, h, min, sec, ms);
}

const primary: DateRange = {
  from: d(2026, 3, 1),
  to: d(2026, 3, 31, 23, 59, 59, 999),
};

describe("computeComparisonRange", () => {
  it("returns null for none", () => {
    expect(computeComparisonRange(primary, "none")).toBeNull();
  });

  it("returns null for custom", () => {
    expect(computeComparisonRange(primary, "custom")).toBeNull();
  });

  it("previous_period: same duration immediately before primary", () => {
    const range: DateRange = {
      from: d(2026, 1, 11),
      to: d(2026, 1, 20, 23, 59, 59, 999),
    };
    const result = computeComparisonRange(range, "previous_period");
    expect(result).not.toBeNull();
    expect(result!.to).toEqual(new Date(range.from.getTime() - 1));
    const durationMs = range.to.getTime() - range.from.getTime();
    expect(result!.from).toEqual(new Date(result!.to.getTime() - durationMs));
  });

  it("previous_month: full calendar month before primary.from", () => {
    const result = computeComparisonRange(primary, "previous_month");
    expect(result).not.toBeNull();
    expect(result!.from).toEqual(d(2026, 2, 1));
    expect(result!.to).toEqual(d(2026, 2, 28, 23, 59, 59, 999));
  });

  it("previous_month: wraps to December of previous year for January", () => {
    const janPrimary: DateRange = {
      from: d(2026, 1, 15),
      to: d(2026, 1, 31, 23, 59, 59, 999),
    };
    const result = computeComparisonRange(janPrimary, "previous_month");
    expect(result).not.toBeNull();
    expect(result!.from).toEqual(d(2025, 12, 1));
    expect(result!.to).toEqual(d(2025, 12, 31, 23, 59, 59, 999));
  });

  it("previous_quarter: Q1 primary -> Q4 of previous year", () => {
    const result = computeComparisonRange(primary, "previous_quarter");
    expect(result).not.toBeNull();
    expect(result!.from).toEqual(d(2025, 10, 1));
    expect(result!.to).toEqual(d(2025, 12, 31, 23, 59, 59, 999));
  });

  it("previous_quarter: Q3 primary -> Q2 same year", () => {
    const q3Primary: DateRange = {
      from: d(2026, 8, 1),
      to: d(2026, 8, 31, 23, 59, 59, 999),
    };
    const result = computeComparisonRange(q3Primary, "previous_quarter");
    expect(result).not.toBeNull();
    expect(result!.from).toEqual(d(2026, 4, 1));
    expect(result!.to).toEqual(d(2026, 6, 30, 23, 59, 59, 999));
  });

  it("previous_year: full year Jan 1 - Dec 31 of year-1", () => {
    const result = computeComparisonRange(primary, "previous_year");
    expect(result).not.toBeNull();
    expect(result!.from).toEqual(d(2025, 1, 1));
    expect(result!.to).toEqual(d(2025, 12, 31, 23, 59, 59, 999));
  });

  it("yoy: same date range shifted back one year", () => {
    const result = computeComparisonRange(primary, "yoy");
    expect(result).not.toBeNull();
    expect(result!.from).toEqual(d(2025, 3, 1));
    expect(result!.to).toEqual(d(2025, 3, 31, 23, 59, 59, 999));
  });
});

// ---------------------------------------------------------------------------
// detectPeriodType
// ---------------------------------------------------------------------------

describe("detectPeriodType", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'day' for a single full day", () => {
    const range: DateRange = { from: d(2026, 3, 15), to: d(2026, 3, 15, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("day");
  });

  it("returns 'day' for yesterday", () => {
    const range: DateRange = { from: d(2026, 4, 17), to: d(2026, 4, 17, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("day");
  });

  it("returns 'week' for a full ISO week (Mon–Sun)", () => {
    // Week 16 of 2026: Apr 13 (Mon) – Apr 19 (Sun)
    const range: DateRange = { from: d(2026, 4, 13), to: d(2026, 4, 19, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("week");
  });

  it("returns 'week' for previous full ISO week", () => {
    // Week 15: Apr 6 – Apr 12
    const range: DateRange = { from: d(2026, 4, 6), to: d(2026, 4, 12, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("week");
  });

  it("returns 'month' for a full calendar month (March)", () => {
    const range: DateRange = { from: d(2026, 3, 1), to: d(2026, 3, 31, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("month");
  });

  it("returns 'month' for February (28 days)", () => {
    const range: DateRange = { from: d(2026, 2, 1), to: d(2026, 2, 28, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("month");
  });

  it("returns 'quarter' for a full Q1 (Jan–Mar)", () => {
    const range: DateRange = { from: d(2026, 1, 1), to: d(2026, 3, 31, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("quarter");
  });

  it("returns 'quarter' for a full Q3 (Jul–Sep)", () => {
    const range: DateRange = { from: d(2026, 7, 1), to: d(2026, 9, 30, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("quarter");
  });

  it("returns 'year' for a full calendar year", () => {
    const range: DateRange = { from: d(2025, 1, 1), to: d(2025, 12, 31, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("year");
  });

  it("returns null for a custom rolling range (30 days)", () => {
    const range: DateRange = { from: d(2026, 3, 19), to: d(2026, 4, 17, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBeNull();
  });

  it("returns null when from is not midnight", () => {
    const range: DateRange = { from: d(2026, 4, 1, 9, 0), to: d(2026, 4, 30, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBeNull();
  });

  it("returns 'month' for current in-progress month (from = 1st, to = today end)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 2026
    const range: DateRange = { from: d(2026, 4, 1), to: d(2026, 4, 18, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("month");
    vi.useRealTimers();
  });

  it("returns 'week' for current in-progress week (Mon to today)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 (Saturday in week 16, Mon=Apr 13)
    // Actually Apr 18 2026 is a Saturday, week starts Apr 13 (Mon)
    const range: DateRange = { from: d(2026, 4, 13), to: d(2026, 4, 18, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("week");
    vi.useRealTimers();
  });

  it("returns null for Monday two weeks ago → today (spans >1 week, must not be 'week')", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 (Sat), current week Mon = Apr 13
    // Two weeks ago Monday: Mar 30
    const range: DateRange = { from: d(2026, 3, 30), to: d(2026, 4, 18, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBeNull();
    vi.useRealTimers();
  });

  it("returns 'year' for current in-progress year (Jan 1 to today, past January)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 2026
    const range: DateRange = { from: d(2026, 1, 1), to: d(2026, 4, 18, 23, 59, 59, 999) };
    expect(detectPeriodType(range)).toBe("year");
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Preset helper unit tests
// ---------------------------------------------------------------------------

describe("isoWeekMonday", () => {
  it("Wednesday 2026-04-15 -> Monday 2026-04-13", () => {
    expect(isoWeekMonday(d(2026, 4, 15))).toEqual(d(2026, 4, 13));
  });

  it("Monday 2026-04-13 -> itself", () => {
    expect(isoWeekMonday(d(2026, 4, 13))).toEqual(d(2026, 4, 13));
  });

  it("Sunday 2026-04-19 -> Monday 2026-04-13", () => {
    expect(isoWeekMonday(d(2026, 4, 19))).toEqual(d(2026, 4, 13));
  });
});

describe("currentQuarterStart", () => {
  it("April is Q2, starts Apr 1", () => {
    expect(currentQuarterStart(d(2026, 4, 15))).toEqual(d(2026, 4, 1));
  });

  it("January is Q1, starts Jan 1", () => {
    expect(currentQuarterStart(d(2026, 1, 15))).toEqual(d(2026, 1, 1));
  });

  it("December is Q4, starts Oct 1", () => {
    expect(currentQuarterStart(d(2026, 12, 1))).toEqual(d(2026, 10, 1));
  });
});

// ---------------------------------------------------------------------------
// navigatePeriod
// ---------------------------------------------------------------------------

describe("navigatePeriod", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns range unchanged for custom/null period", () => {
    const range: DateRange = { from: d(2026, 3, 19), to: d(2026, 4, 17, 23, 59, 59, 999) };
    expect(navigatePeriod(range, -1)).toStrictEqual(range);
    expect(navigatePeriod(range, 1)).toStrictEqual(range);
  });

  // Day navigation
  it("day: navigates back one day", () => {
    const range: DateRange = { from: d(2026, 4, 18), to: d(2026, 4, 18, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1);
    expect(result.from).toEqual(d(2026, 4, 17));
    expect(result.to).toEqual(d(2026, 4, 17, 23, 59, 59, 999));
  });

  it("day: navigates forward one day", () => {
    const range: DateRange = { from: d(2026, 4, 17), to: d(2026, 4, 17, 23, 59, 59, 999) };
    const result = navigatePeriod(range, 1);
    expect(result.from).toEqual(d(2026, 4, 18));
    expect(result.to).toEqual(d(2026, 4, 18, 23, 59, 59, 999));
  });

  // Week navigation
  it("week: navigates back one full ISO week", () => {
    // Week 16: Apr 13–19 2026
    const range: DateRange = { from: d(2026, 4, 13), to: d(2026, 4, 19, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1);
    expect(result.from).toEqual(d(2026, 4, 6));
    expect(result.to).toEqual(d(2026, 4, 12, 23, 59, 59, 999));
  });

  it("week: navigates forward one full ISO week", () => {
    // Use a past week far from today: Jan 5–11 2026 (Mon) → Jan 12–18 2026
    const range: DateRange = { from: d(2026, 1, 5), to: d(2026, 1, 11, 23, 59, 59, 999) };
    const result = navigatePeriod(range, 1);
    expect(result.from).toEqual(d(2026, 1, 12));
    expect(result.to).toEqual(d(2026, 1, 18, 23, 59, 59, 999));
  });

  it("week: Mon-only current week is detected as day; periodType week steps back one ISO week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 13, 12, 0, 0)); // Apr 13 2026 = Monday
    const range: DateRange = {
      from: d(2026, 4, 13, 0, 0, 0, 0),
      to: d(2026, 4, 13, 23, 59, 59, 999),
    };
    expect(detectPeriodType(range)).toBe("day");
    const result = navigatePeriod(range, -1, { periodType: "week" });
    expect(result.from).toEqual(d(2026, 4, 6, 0, 0, 0, 0));
    expect(result.to).toEqual(d(2026, 4, 12, 23, 59, 59, 999));
    vi.useRealTimers();
  });

  it("week: Mon-only current week with periodType week steps forward to next ISO week (→ disabled in UI)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 13, 12, 0, 0)); // Monday Apr 13 2026
    const range: DateRange = {
      from: d(2026, 4, 13, 0, 0, 0, 0),
      to: d(2026, 4, 13, 23, 59, 59, 999),
    };
    const result = navigatePeriod(range, 1, { periodType: "week" });
    expect(result.from).toEqual(d(2026, 4, 20, 0, 0, 0, 0));
    expect(result.to).toEqual(d(2026, 4, 26, 23, 59, 59, 999));
    const startOfToday = new Date(2026, 3, 13, 0, 0, 0, 0);
    expect(result.from > startOfToday).toBe(true);
    vi.useRealTimers();
  });

  // Month navigation
  it("month: navigates back — April → March", () => {
    const range: DateRange = { from: d(2026, 4, 1), to: d(2026, 4, 30, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1);
    expect(result.from).toEqual(d(2026, 3, 1));
    expect(result.to).toEqual(d(2026, 3, 31, 23, 59, 59, 999));
  });

  it("month: navigates forward — March → April (current, to = today)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 2026
    const range: DateRange = { from: d(2026, 3, 1), to: d(2026, 3, 31, 23, 59, 59, 999) };
    const result = navigatePeriod(range, 1);
    expect(result.from).toEqual(d(2026, 4, 1));
    expect(result.to).toEqual(d(2026, 4, 18, 23, 59, 59, 999)); // end of today
    vi.useRealTimers();
  });

  it("month: Jan → Dec wraps to previous year", () => {
    const range: DateRange = { from: d(2026, 1, 1), to: d(2026, 1, 31, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1);
    expect(result.from).toEqual(d(2025, 12, 1));
    expect(result.to).toEqual(d(2025, 12, 31, 23, 59, 59, 999));
  });

  it("month: Feb leap year handled correctly", () => {
    const range: DateRange = { from: d(2026, 1, 1), to: d(2026, 1, 31, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1); // → Dec 2025
    const resultBack = navigatePeriod(result, -1); // → Nov 2025
    expect(resultBack.from).toEqual(d(2025, 11, 1));
    expect(resultBack.to).toEqual(d(2025, 11, 30, 23, 59, 59, 999));
  });

  // Quarter navigation
  it("quarter: navigates back — Q2 → Q1", () => {
    const range: DateRange = { from: d(2026, 4, 1), to: d(2026, 6, 30, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1);
    expect(result.from).toEqual(d(2026, 1, 1));
    expect(result.to).toEqual(d(2026, 3, 31, 23, 59, 59, 999));
  });

  it("quarter: Q1 → Q4 of prior year", () => {
    const range: DateRange = { from: d(2026, 1, 1), to: d(2026, 3, 31, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1);
    expect(result.from).toEqual(d(2025, 10, 1));
    expect(result.to).toEqual(d(2025, 12, 31, 23, 59, 59, 999));
  });

  it("quarter: navigates forward — Q1 → Q2 (current, to = today)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 2026 (Q2)
    const range: DateRange = { from: d(2026, 1, 1), to: d(2026, 3, 31, 23, 59, 59, 999) };
    const result = navigatePeriod(range, 1);
    expect(result.from).toEqual(d(2026, 4, 1));
    expect(result.to).toEqual(d(2026, 4, 18, 23, 59, 59, 999)); // end of today
    vi.useRealTimers();
  });

  // Year navigation
  it("year: navigates back — 2026 → 2025", () => {
    const range: DateRange = { from: d(2026, 1, 1), to: d(2026, 12, 31, 23, 59, 59, 999) };
    const result = navigatePeriod(range, -1);
    expect(result.from).toEqual(d(2025, 1, 1));
    expect(result.to).toEqual(d(2025, 12, 31, 23, 59, 59, 999));
  });

  it("year: navigates forward into current year (to = today)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 2026
    const range: DateRange = { from: d(2025, 1, 1), to: d(2025, 12, 31, 23, 59, 59, 999) };
    const result = navigatePeriod(range, 1);
    expect(result.from).toEqual(d(2026, 1, 1));
    expect(result.to).toEqual(d(2026, 4, 18, 23, 59, 59, 999)); // end of today
    vi.useRealTimers();
  });

  // Forward disabled: navigatePeriod(currentMonth, +1).from > startOfToday
  it("forward from current month produces next month start > today (disabled condition)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 18, 12, 0, 0)); // Apr 18 2026
    const currentMonth: DateRange = { from: d(2026, 4, 1), to: d(2026, 4, 18, 23, 59, 59, 999) };
    const next = navigatePeriod(currentMonth, 1);
    const startOfToday = new Date(2026, 3, 18, 0, 0, 0, 0);
    expect(next.from > startOfToday).toBe(true); // May 1 > Apr 18 → button disabled
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Preset range tests — fixed date: Wednesday 2026-04-15
// ---------------------------------------------------------------------------

// Fixed "now" = 2026-04-15 (Wednesday) at noon, to avoid DST edge cases
const FIXED_NOW = new Date(2026, 3, 15, 12, 0, 0, 0); // month is 0-indexed: 3 = April

describe("CURRENT_PRESETS (fixed date: 2026-04-15 Wednesday)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Hoy: 2026-04-15 00:00 – 23:59:59", () => {
    const preset = CURRENT_PRESETS.find((p) => p.label === "Hoy")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 4, 15, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 4, 15, 23, 59, 59, 999));
  });

  it("Semana actual: Mon 2026-04-13 – today 2026-04-15", () => {
    const preset = CURRENT_PRESETS.find((p) => p.label === "Semana actual")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 4, 13, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 4, 15, 23, 59, 59, 999));
  });

  it("Mes actual: 2026-04-01 – 2026-04-15", () => {
    const preset = CURRENT_PRESETS.find((p) => p.label === "Mes actual")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 4, 1, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 4, 15, 23, 59, 59, 999));
  });

  it("Trimestre actual: Q2 starts 2026-04-01 – 2026-04-15", () => {
    const preset = CURRENT_PRESETS.find((p) => p.label === "Trimestre actual")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 4, 1, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 4, 15, 23, 59, 59, 999));
  });

  it("Año actual: 2026-01-01 – 2026-04-15", () => {
    const preset = CURRENT_PRESETS.find((p) => p.label === "Año actual")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 1, 1, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 4, 15, 23, 59, 59, 999));
  });
});

describe("PREVIOUS_PRESETS (fixed date: 2026-04-15 Wednesday)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Ayer: 2026-04-14 00:00 – 23:59:59", () => {
    const preset = PREVIOUS_PRESETS.find((p) => p.label === "Ayer")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 4, 14, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 4, 14, 23, 59, 59, 999));
  });

  it("Semana anterior: Mon 2026-04-06 – Sun 2026-04-12", () => {
    const preset = PREVIOUS_PRESETS.find((p) => p.label === "Semana anterior")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 4, 6, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 4, 12, 23, 59, 59, 999));
  });

  it("Mes anterior: 2026-03-01 – 2026-03-31", () => {
    const preset = PREVIOUS_PRESETS.find((p) => p.label === "Mes anterior")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 3, 1, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 3, 31, 23, 59, 59, 999));
  });

  it("Trimestre anterior: Q1 2026-01-01 – 2026-03-31", () => {
    const preset = PREVIOUS_PRESETS.find((p) => p.label === "Trimestre anterior")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2026, 1, 1, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2026, 3, 31, 23, 59, 59, 999));
  });

  it("Año anterior: 2025-01-01 – 2025-12-31", () => {
    const preset = PREVIOUS_PRESETS.find((p) => p.label === "Año anterior")!;
    const range = preset.range();
    expect(range.from).toEqual(d(2025, 1, 1, 0, 0, 0, 0));
    expect(range.to).toEqual(d(2025, 12, 31, 23, 59, 59, 999));
  });
});

describe("formatPeriodLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels Hoy for today preset", () => {
    const range = CURRENT_PRESETS.find((p) => p.label === "Hoy")!.range();
    expect(formatPeriodLabel(range)).toBe("Hoy");
  });

  it("labels Ayer for yesterday preset", () => {
    const range = PREVIOUS_PRESETS.find((p) => p.label === "Ayer")!.range();
    expect(formatPeriodLabel(range)).toBe("Ayer");
  });

  it("labels previous month as long month + year", () => {
    const range = PREVIOUS_PRESETS.find((p) => p.label === "Mes anterior")!.range();
    expect(formatPeriodLabel(range)).toMatch(/marzo.*2026/i);
  });

  it("labels previous quarter as T1 • ene-mar", () => {
    const range = PREVIOUS_PRESETS.find((p) => p.label === "Trimestre anterior")!.range();
    expect(formatPeriodLabel(range)).toBe("T1 2026 • ene-mar");
  });

  it("labels previous year as 2025", () => {
    const range = PREVIOUS_PRESETS.find((p) => p.label === "Año anterior")!.range();
    expect(formatPeriodLabel(range)).toBe("2025");
  });

  it("labels current week with arrow suffix", () => {
    const range = CURRENT_PRESETS.find((p) => p.label === "Semana actual")!.range();
    expect(formatPeriodLabel(range)).toMatch(/^Semana \d+ • .+→$/);
  });

  it("labels Semana actual on Monday as week (not Hoy) when navPeriodOverride is week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 13, 12, 0, 0)); // Monday Apr 13 2026
    const range = CURRENT_PRESETS.find((p) => p.label === "Semana actual")!.range();
    expect(detectPeriodType(range)).toBe("day");
    expect(formatPeriodLabel(range, { navPeriodOverride: "week" })).toMatch(/^Semana \d+ • .+→$/);
    vi.useRealTimers();
  });

  it("falls back to compact range for custom rolling range (year once)", () => {
    const range: DateRange = {
      from: d(2026, 4, 10, 0, 0, 0, 0),
      to: d(2026, 4, 18, 23, 59, 59, 999),
    };
    expect(detectPeriodType(range)).toBeNull();
    const label = formatPeriodLabel(range);
    expect(label).toContain("–");
    expect(label.match(/2026/g)?.length).toBe(1);
  });

  it("labels current quarter as T2 when preferQuarterOverMonth is set (April in-progress)", () => {
    const range = CURRENT_PRESETS.find((p) => p.label === "Trimestre actual")!.range();
    expect(detectPeriodType(range)).toBe("month");
    expect(detectPeriodType(range, { preferQuarterOverMonth: true })).toBe("quarter");
    expect(formatPeriodLabel(range, { preferQuarterOverMonth: true })).toBe(
      "T2 2026 • abr-jun",
    );
  });

  it("labels Monday start of current week with arrow suffix", () => {
    const monday = isoWeekMonday(FIXED_NOW);
    const range: DateRange = {
      from: d(monday.getFullYear(), monday.getMonth() + 1, monday.getDate(), 0, 0, 0, 0),
      to: d(2026, 4, 15, 23, 59, 59, 999),
    };
    expect(detectPeriodType(range)).toBe("week");
    expect(formatPeriodLabel(range)).toMatch(/^Semana \d+ • .+→$/);
  });
});

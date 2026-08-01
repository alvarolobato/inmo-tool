import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  substituteTimeRange,
  presetToDateRange,
  defaultTimeRangeToDateRange,
  toISODateString,
} from "../time-range";

const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toISODateString", () => {
  it("formats a date as YYYY-MM-DD", () => {
    const d = new Date(2026, 2, 15);
    expect(toISODateString(d)).toBe("2026-03-15");
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 0, 5);
    expect(toISODateString(d)).toBe("2026-01-05");
  });
});

describe("substituteTimeRange", () => {
  it("replaces {{date_from}} and {{date_to}} placeholders", () => {
    const sql = "WHERE fecha_creacion BETWEEN '{{date_from}}' AND '{{date_to}}'";
    expect(substituteTimeRange(sql, "2026-01-01", "2026-01-31")).toBe(
      "WHERE fecha_creacion BETWEEN '2026-01-01' AND '2026-01-31'"
    );
  });

  it("returns SQL unchanged when no placeholders are present", () => {
    const sql = "SELECT * FROM t";
    expect(substituteTimeRange(sql, "2026-01-01", "2026-01-31")).toBe(sql);
  });

  it("replaces ALL occurrences of each placeholder", () => {
    const sql = "SELECT '{{date_from}}' AS f, '{{date_to}}' AS t, '{{date_from}}' AS f2";
    expect(substituteTimeRange(sql, "2026-01-01", "2026-01-31")).toBe(
      "SELECT '2026-01-01' AS f, '2026-01-31' AS t, '2026-01-01' AS f2"
    );
  });
});

describe("presetToDateRange", () => {
  it("today: returns full day 00:00:00 to 23:59:59", () => {
    const range = presetToDateRange("today");
    expect(toISODateString(range.from)).toBe("2026-03-15");
    expect(toISODateString(range.to)).toBe("2026-03-15");
    expect(range.from.getHours()).toBe(0);
    expect(range.to.getHours()).toBe(23);
  });

  it("last_7_days: from 6 days ago to today", () => {
    const range = presetToDateRange("last_7_days");
    expect(toISODateString(range.from)).toBe("2026-03-09");
    expect(toISODateString(range.to)).toBe("2026-03-15");
  });

  it("last_30_days: from 29 days ago to today", () => {
    const range = presetToDateRange("last_30_days");
    expect(toISODateString(range.from)).toBe("2026-02-14");
    expect(toISODateString(range.to)).toBe("2026-03-15");
  });

  it("current_month: from 1st of current month to today", () => {
    const range = presetToDateRange("current_month");
    expect(toISODateString(range.from)).toBe("2026-03-01");
    expect(toISODateString(range.to)).toBe("2026-03-15");
  });

  it("last_month: full February 2026 when current month is March", () => {
    const range = presetToDateRange("last_month");
    expect(toISODateString(range.from)).toBe("2026-02-01");
    expect(toISODateString(range.to)).toBe("2026-02-28");
  });

  it("year_to_date: from Jan 1 of current year to today", () => {
    const range = presetToDateRange("year_to_date");
    expect(toISODateString(range.from)).toBe("2026-01-01");
    expect(toISODateString(range.to)).toBe("2026-03-15");
  });
});

describe("defaultTimeRangeToDateRange", () => {
  it("uses the given preset when provided", () => {
    const range = defaultTimeRangeToDateRange({ preset: "current_month" });
    expect(toISODateString(range.from)).toBe("2026-03-01");
    expect(toISODateString(range.to)).toBe("2026-03-15");
  });

  it("falls back to last_30_days when undefined", () => {
    const range = defaultTimeRangeToDateRange(undefined);
    expect(toISODateString(range.from)).toBe("2026-02-14");
    expect(toISODateString(range.to)).toBe("2026-03-15");
  });
});

import { describe, it, expect } from "vitest";
import {
  formatAgeSeconds,
  formatDuration,
  formatNumber,
  formatThroughput,
} from "../etl-format";

describe("formatDuration", () => {
  it("handles null/undefined", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });

  it("formats sub-second, seconds, minutes, hours", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(3 * 60_000 + 7_000)).toBe("3m 7s");
    expect(formatDuration(2 * 3600_000 + 15 * 60_000)).toBe("2h 15m");
  });
});

describe("formatNumber", () => {
  it("handles null/undefined", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
  });

  it("produces a grouped numeric string", () => {
    // Strip non-digits so the test passes regardless of ICU locale data.
    expect(formatNumber(1_234_567)?.replace(/\D/g, "")).toBe("1234567");
  });
});

describe("formatAgeSeconds", () => {
  it("returns dash for null/NaN", () => {
    expect(formatAgeSeconds(null)).toBe("—");
    expect(formatAgeSeconds(undefined)).toBe("—");
    expect(formatAgeSeconds(Number.NaN)).toBe("—");
  });

  it("formats under-a-minute ages", () => {
    expect(formatAgeSeconds(42)).toBe("< 1m");
    expect(formatAgeSeconds(-5)).toBe("< 1m");
  });

  it("formats minutes only", () => {
    expect(formatAgeSeconds(15 * 60)).toBe("15m");
  });

  it("formats hours and minutes", () => {
    expect(formatAgeSeconds(2 * 3600 + 30 * 60)).toBe("2h 30m");
  });

  it("formats days and hours for large values", () => {
    expect(formatAgeSeconds(3 * 86400 + 4 * 3600)).toBe("3d 4h");
  });
});

describe("formatThroughput", () => {
  it("returns dash for null/NaN", () => {
    expect(formatThroughput(null)).toBe("—");
    expect(formatThroughput(Number.NaN)).toBe("—");
  });

  it("formats sub-thousand with one decimal", () => {
    expect(formatThroughput(12.78)).toBe("12.8 /s");
    expect(formatThroughput(0.5)).toBe("0.5 /s");
  });

  it("rounds to integer for large values", () => {
    const out = formatThroughput(1234.5);
    expect(out.endsWith(" /s")).toBe(true);
    expect(out.replace(/\D/g, "")).toBe("1235");
  });
});

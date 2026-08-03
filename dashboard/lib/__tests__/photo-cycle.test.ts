import { describe, it, expect } from "vitest";
import { wrapIndex } from "../photo-cycle";

describe("wrapIndex", () => {
  it("advances by delta within bounds", () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(1, 1, 3)).toBe(2);
    expect(wrapIndex(2, -1, 3)).toBe(1);
  });

  it("wraps forward past the last index back to 0", () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
  });

  it("wraps backward past 0 to the last index", () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });

  it("is a no-op cycle for a single-photo array (wraps to itself)", () => {
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, -1, 1)).toBe(0);
  });

  it("returns 0 for a zero-length array instead of throwing or producing NaN", () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(wrapIndex(0, -1, 0)).toBe(0);
  });

  it("matches PhotoGallery's lightbox step() formula for the same inputs (shared semantics, #167)", () => {
    // (current + delta + length) % length — same cases the lightbox's own
    // wrap-around behaviour exercises, so both controls agree on what
    // "next"/"previous" mean.
    const length = 5;
    let current = 0;
    for (const delta of [1, 1, 1, 1, 1, 1]) {
      current = wrapIndex(current, delta, length);
    }
    // 6 forward steps over a 5-photo array lands back on index 1.
    expect(current).toBe(1);
  });
});

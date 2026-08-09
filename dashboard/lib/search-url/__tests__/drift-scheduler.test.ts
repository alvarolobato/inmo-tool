// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isDriftCheckDue } from "../drift-scheduler";

describe("isDriftCheckDue — weekly drift cadence (#511)", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  it("is due when never checked (null)", () => {
    expect(isDriftCheckDue(null, now, 7)).toBe(true);
  });

  it("is due when the last capture timestamp is unparseable", () => {
    expect(isDriftCheckDue("garbage", now, 7)).toBe(true);
  });

  it("is not due when the last check is within the interval", () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * DAY).toISOString();
    expect(isDriftCheckDue(threeDaysAgo, now, 7)).toBe(false);
  });

  it("is due exactly at the interval boundary", () => {
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY).toISOString();
    expect(isDriftCheckDue(sevenDaysAgo, now, 7)).toBe(true);
  });

  it("is due once the interval has elapsed", () => {
    const eightDaysAgo = new Date(now.getTime() - 8 * DAY).toISOString();
    expect(isDriftCheckDue(eightDaysAgo, now, 7)).toBe(true);
  });

  it("honours a custom interval", () => {
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY).toISOString();
    expect(isDriftCheckDue(twoDaysAgo, now, 1)).toBe(true);
    expect(isDriftCheckDue(twoDaysAgo, now, 3)).toBe(false);
  });
});

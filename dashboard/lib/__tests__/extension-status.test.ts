// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isLinked, LINKED_WINDOW_MS, compareVersions, updateAvailable } from "../extension-status";

describe("isLinked — extension presence window (#509)", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  it("is not linked when never seen (null / empty)", () => {
    expect(isLinked(null, now)).toBe(false);
    expect(isLinked("", now)).toBe(false);
  });

  it("is not linked when the timestamp is unparseable", () => {
    expect(isLinked("not-a-date", now)).toBe(false);
  });

  it("is linked when the last heartbeat is within the window", () => {
    const recent = new Date(now.getTime() - (LINKED_WINDOW_MS - 1000)).toISOString();
    expect(isLinked(recent, now)).toBe(true);
  });

  it("is linked exactly at the window boundary", () => {
    const boundary = new Date(now.getTime() - LINKED_WINDOW_MS).toISOString();
    expect(isLinked(boundary, now)).toBe(true);
  });

  it("is not linked when the last heartbeat is older than the window", () => {
    const stale = new Date(now.getTime() - (LINKED_WINDOW_MS + 1000)).toISOString();
    expect(isLinked(stale, now)).toBe(false);
  });
});

describe("compareVersions — dotted numeric ordering (#527)", () => {
  it("orders by each numeric part left to right", () => {
    expect(compareVersions("0.13.2", "0.14.2")).toBe(-1);
    expect(compareVersions("0.14.2", "0.13.2")).toBe(1);
    expect(compareVersions("0.14.2", "0.14.2")).toBe(0);
  });

  it("compares numerically, not lexically (10 > 9)", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("0.14.10", "0.14.2")).toBe(1);
  });

  it("treats missing trailing parts as zero", () => {
    expect(compareVersions("0.14", "0.14.0")).toBe(0);
    expect(compareVersions("0.14", "0.14.1")).toBe(-1);
    expect(compareVersions("1", "1.0.0")).toBe(0);
  });

  it("returns 0 for an incomparable (non-numeric) part — never a false ordering", () => {
    expect(compareVersions("0.14.x", "0.14.2")).toBe(0);
    expect(compareVersions("beta", "0.14.2")).toBe(0);
  });
});

describe("updateAvailable — installed vs served (#527)", () => {
  it("is true only when the installed version is strictly older", () => {
    expect(updateAvailable("0.13.2", "0.14.2")).toBe(true);
    expect(updateAvailable("0.14.2", "0.14.2")).toBe(false);
    expect(updateAvailable("0.15.0", "0.14.2")).toBe(false);
  });

  it("is false when either side is unknown (never nag on uncertainty)", () => {
    expect(updateAvailable(null, "0.14.2")).toBe(false);
    expect(updateAvailable("0.13.2", null)).toBe(false);
    expect(updateAvailable(null, null)).toBe(false);
  });

  it("is false for an incomparable pair", () => {
    expect(updateAvailable("0.14.x", "0.14.2")).toBe(false);
  });
});

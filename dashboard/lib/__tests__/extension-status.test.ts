// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isLinked, LINKED_WINDOW_MS } from "../extension-status";

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

/**
 * Unit tests for the deterministic task-id hash (issue #277).
 */

import { describe, it, expect } from "vitest";
import { stableTaskId } from "@/lib/search-url/task-id";

const KEY = {
  portal: "idealista",
  section: "venta-viviendas",
  location: "estepona-malaga",
  priceMax: 200000,
};

describe("stableTaskId", () => {
  it("is deterministic — equal keys produce equal ids", () => {
    expect(stableTaskId(KEY)).toBe(stableTaskId({ ...KEY }));
  });

  it("prefixes portal:section and appends an 8-hex hash", () => {
    expect(stableTaskId(KEY)).toMatch(/^idealista:venta-viviendas:[0-9a-f]{8}$/);
  });

  it("changes when any filter changes", () => {
    const base = stableTaskId(KEY);
    expect(stableTaskId({ ...KEY, priceMax: 150000 })).not.toBe(base);
    expect(stableTaskId({ ...KEY, priceMin: 50000 })).not.toBe(base);
    expect(stableTaskId({ ...KEY, location: "marbella-malaga" })).not.toBe(base);
    expect(stableTaskId({ ...KEY, roomsMin: 4 })).not.toBe(base);
    expect(stableTaskId({ ...KEY, sizeMin: 60 })).not.toBe(base);
    expect(stableTaskId({ ...KEY, sizeMax: 120 })).not.toBe(base);
  });

  it("distinguishes sections and portals", () => {
    expect(stableTaskId({ ...KEY, section: "venta-garajes" })).not.toBe(stableTaskId(KEY));
    expect(stableTaskId({ ...KEY, portal: "aliseda" })).not.toBe(stableTaskId(KEY));
  });
});

/**
 * Unit tests for the data-health pure helpers (issue #272). Pure functions,
 * no DB — the classification logic every section of the "Salud de datos" page
 * turns on. EC-2 (stuck-pending threshold boundary) is pinned here.
 */

import { describe, it, expect } from "vitest";
import {
  captureSuccessRate,
  connectorHealthLevel,
  extensionBlockNoticeEs,
  hasCleanNotice,
  hostToPortal,
  isLowPhotoCoverage,
  isStaleProfile,
  isStuckPending,
  LOW_PHOTO_THRESHOLD,
  STUCK_PENDING_SECONDS,
} from "../data-health";

describe("connectorHealthLevel", () => {
  it("treats ok and skipped as healthy (budget/soft-block stops are clean)", () => {
    expect(connectorHealthLevel("ok")).toBe("healthy");
    expect(connectorHealthLevel("skipped")).toBe("healthy");
  });

  it("treats circuit_open and failed as attention-worthy", () => {
    expect(connectorHealthLevel("circuit_open")).toBe("attention");
    expect(connectorHealthLevel("failed")).toBe("attention");
  });

  it("defaults an unknown status to healthy rather than crying wolf", () => {
    expect(connectorHealthLevel("weird")).toBe("healthy");
  });
});

describe("hasCleanNotice", () => {
  it("flags an ok run carrying a budget/soft-block notice as an INFO note", () => {
    expect(hasCleanNotice("ok", "nota: presupuesto agotado")).toBe(true);
  });

  it("does not treat an ok run with no notice as a note", () => {
    expect(hasCleanNotice("ok", null)).toBe(false);
    expect(hasCleanNotice("ok", "   ")).toBe(false);
  });

  it("never turns an attention-level run's message into a clean note", () => {
    expect(hasCleanNotice("failed", "boom")).toBe(false);
    expect(hasCleanNotice("circuit_open", "tripped")).toBe(false);
  });
});

describe("isStuckPending (EC-2)", () => {
  it("is false when nothing is pending", () => {
    expect(isStuckPending(null)).toBe(false);
  });

  it("is false at or below the threshold, true strictly above it", () => {
    expect(isStuckPending(STUCK_PENDING_SECONDS - 1)).toBe(false);
    expect(isStuckPending(STUCK_PENDING_SECONDS)).toBe(false); // boundary: not yet stuck
    expect(isStuckPending(STUCK_PENDING_SECONDS + 1)).toBe(true);
  });

  it("uses a 5-minute threshold", () => {
    expect(STUCK_PENDING_SECONDS).toBe(300);
  });
});

describe("captureSuccessRate", () => {
  it("is null when there were no terminal captures (no divide by zero)", () => {
    expect(captureSuccessRate(0, 0)).toBeNull();
  });

  it("computes done / (done + failed)", () => {
    expect(captureSuccessRate(9, 1)).toBeCloseTo(0.9, 5);
    expect(captureSuccessRate(1, 1)).toBeCloseTo(0.5, 5);
    expect(captureSuccessRate(3, 0)).toBe(1);
  });
});

describe("isLowPhotoCoverage", () => {
  it("flags an average strictly below the threshold", () => {
    expect(isLowPhotoCoverage(1)).toBe(true);
    expect(isLowPhotoCoverage(LOW_PHOTO_THRESHOLD - 0.1)).toBe(true);
  });

  it("does not flag at or above the threshold", () => {
    expect(isLowPhotoCoverage(LOW_PHOTO_THRESHOLD)).toBe(false);
    expect(isLowPhotoCoverage(10)).toBe(false);
  });

  it("does not flag when there is no data", () => {
    expect(isLowPhotoCoverage(null)).toBe(false);
  });
});

describe("isStaleProfile", () => {
  it("is not stale when there is no listing data at all", () => {
    expect(isStaleProfile(null, null)).toBe(false);
    expect(isStaleProfile("2026-01-01T00:00:00Z", null)).toBe(false);
  });

  it("is stale when never materialized but data exists", () => {
    expect(isStaleProfile(null, "2026-01-01T00:00:00Z")).toBe(true);
  });

  it("is stale when data is newer than last materialization", () => {
    expect(isStaleProfile("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(true);
  });

  it("is not stale when materialization is newer than or equal to the data", () => {
    expect(isStaleProfile("2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(false);
    expect(isStaleProfile("2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(false);
  });
});

describe("hostToPortal", () => {
  it("maps a known capture host to its portal name", () => {
    expect(hostToPortal("www.idealista.com")).toBe("idealista");
    expect(hostToPortal("alisedainmobiliaria.com")).toBe("aliseda");
  });

  it("maps a subdomain of a known host to its portal", () => {
    expect(hostToPortal("m.idealista.com")).toBe("idealista");
  });

  it("falls back to the bare host for an unknown portal", () => {
    expect(hostToPortal("www.fotocasa.es")).toBe("fotocasa.es");
  });

  it("returns a placeholder for an empty host", () => {
    expect(hostToPortal("")).toBe("desconocido");
  });
});

describe("extensionBlockNoticeEs (issue #634)", () => {
  it("renders a D-047-style clean 'nota:' line with the Spanish signature label", () => {
    const msg = extensionBlockNoticeEs({
      portal: "idealista",
      signature: "captcha_wall",
      detected_at: "2026-08-20T10:00:00.000Z",
      resolved_at: null,
    });
    expect(msg).toBe("nota: captura de idealista pausada por bloqueo (muro CAPTCHA)");
  });

  it("falls back to the raw signature id when it isn't in the label map", () => {
    const msg = extensionBlockNoticeEs({
      portal: "aliseda",
      signature: "some_future_signature",
      detected_at: "2026-08-20T10:00:00.000Z",
      resolved_at: null,
    });
    expect(msg).toContain("some_future_signature");
  });
});

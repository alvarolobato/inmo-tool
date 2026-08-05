import { describe, it, expect } from "vitest";
import {
  buildPortalCaptureViews,
  capturedPct,
  captureTotals,
  portalLabel,
} from "@/lib/captura-view";
import type { PortalSearchUrl } from "@/lib/search-url";
import type { WorklistPortalSummary } from "@/lib/worklist";

function url(portal: string, loosened: PortalSearchUrl["loosened"] = []): PortalSearchUrl {
  return { portal, url: `https://${portal}.example/venta`, loosened };
}

function summary(portal: string, over: Partial<WorklistPortalSummary> = {}): WorklistPortalSummary {
  return {
    source_portal: portal,
    total: 10,
    pending: 4,
    captured: 5,
    failed: 1,
    skipped: 0,
    ...over,
  };
}

describe("capturedPct", () => {
  it("returns 0 for a null summary", () => {
    expect(capturedPct(null)).toBe(0);
  });

  it("returns 0 when total is 0 (never divides by zero)", () => {
    expect(capturedPct(summary("x", { total: 0, captured: 0 }))).toBe(0);
  });

  it("rounds captured/total to an integer percentage", () => {
    expect(capturedPct(summary("x", { total: 3, captured: 1 }))).toBe(33);
    expect(capturedPct(summary("x", { total: 8, captured: 5 }))).toBe(63);
    expect(capturedPct(summary("x", { total: 10, captured: 10 }))).toBe(100);
  });
});

describe("buildPortalCaptureViews", () => {
  it("joins each search URL to its worklist summary, preserving URL order", () => {
    const urls = [url("idealista"), url("aliseda")];
    const summaries = [summary("aliseda", { total: 4, captured: 2 })];
    const views = buildPortalCaptureViews(urls, summaries);

    expect(views.map((v) => v.portal)).toEqual(["idealista", "aliseda"]);
    // idealista has no worklist rows → null summary, 0%
    expect(views[0].summary).toBeNull();
    expect(views[0].capturedPct).toBe(0);
    // aliseda matched → summary + computed pct
    expect(views[1].summary?.captured).toBe(2);
    expect(views[1].capturedPct).toBe(50);
  });

  it("carries the search URL and loosened flags through unchanged", () => {
    const loosened = [{ constraint: "geography" as const, reason: "sin radio" }];
    const views = buildPortalCaptureViews([url("aliseda", loosened)], []);
    expect(views[0].searchUrl).toBe("https://aliseda.example/venta");
    expect(views[0].loosened).toEqual(loosened);
  });

  it("returns an empty array when there are no search URLs", () => {
    expect(buildPortalCaptureViews([], [summary("aliseda")])).toEqual([]);
  });

  it("ignores summaries for portals with no search URL", () => {
    const views = buildPortalCaptureViews([url("idealista")], [summary("cimenta2")]);
    expect(views).toHaveLength(1);
    expect(views[0].portal).toBe("idealista");
    expect(views[0].summary).toBeNull();
  });
});

describe("captureTotals", () => {
  it("sums counts across portals and computes the overall percentage", () => {
    const views = buildPortalCaptureViews(
      [url("idealista"), url("aliseda")],
      [
        summary("idealista", { total: 10, pending: 6, captured: 4, failed: 0, skipped: 0 }),
        summary("aliseda", { total: 10, pending: 4, captured: 6, failed: 0, skipped: 0 }),
      ],
    );
    const t = captureTotals(views);
    expect(t.portals).toBe(2);
    expect(t.total).toBe(20);
    expect(t.captured).toBe(10);
    expect(t.pending).toBe(10);
    expect(t.capturedPct).toBe(50);
  });

  it("counts portals with no summary but contributes 0 to the counts", () => {
    const views = buildPortalCaptureViews([url("idealista"), url("aliseda")], []);
    const t = captureTotals(views);
    expect(t.portals).toBe(2);
    expect(t.total).toBe(0);
    expect(t.capturedPct).toBe(0);
  });

  it("handles the empty-views case", () => {
    const t = captureTotals([]);
    expect(t).toMatchObject({ portals: 0, total: 0, captured: 0, capturedPct: 0 });
  });
});

describe("portalLabel", () => {
  it("title-cases a portal key", () => {
    expect(portalLabel("idealista")).toBe("Idealista");
    expect(portalLabel("aliseda")).toBe("Aliseda");
  });

  it("returns the empty string unchanged", () => {
    expect(portalLabel("")).toBe("");
  });
});

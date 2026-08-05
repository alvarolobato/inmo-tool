import { describe, it, expect } from "vitest";
import {
  buildPortalCaptureViews,
  capturedPct,
  captureTotals,
  portalLabel,
} from "@/lib/captura-view";
import type { SearchTask } from "@/lib/search-url";
import type { WorklistPortalSummary } from "@/lib/worklist";

function task(portal: string, over: Partial<SearchTask> = {}): SearchTask {
  return {
    id: over.id ?? `${portal}:section:0000abcd`,
    portal,
    label: over.label ?? `${portal} — pisos`,
    url: over.url ?? `https://${portal}.example/venta`,
    loosened: over.loosened ?? [],
  };
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
  it("groups tasks by portal and joins each portal to its worklist summary, preserving order", () => {
    const tasks = [task("idealista"), task("aliseda")];
    const summaries = [summary("aliseda", { total: 4, captured: 2 })];
    const views = buildPortalCaptureViews(tasks, summaries);

    expect(views.map((v) => v.portal)).toEqual(["idealista", "aliseda"]);
    // idealista has no worklist rows → null summary, 0%
    expect(views[0].summary).toBeNull();
    expect(views[0].capturedPct).toBe(0);
    // aliseda matched → summary + computed pct
    expect(views[1].summary?.captured).toBe(2);
    expect(views[1].capturedPct).toBe(50);
  });

  it("collects several tasks for the same portal into one view (first-seen order)", () => {
    const tasks = [
      task("aliseda", { id: "aliseda:pisos:1", url: "https://a/pisos" }),
      task("aliseda", { id: "aliseda:aticos:2", url: "https://a/aticos" }),
    ];
    const views = buildPortalCaptureViews(tasks, []);
    expect(views).toHaveLength(1);
    expect(views[0].tasks.map((t) => t.url)).toEqual(["https://a/pisos", "https://a/aticos"]);
  });

  it("carries each task's url + loosened flags through unchanged", () => {
    const loosened = [{ constraint: "geography" as const, reason: "sin radio" }];
    const views = buildPortalCaptureViews([task("aliseda", { loosened })], []);
    expect(views[0].tasks[0].url).toBe("https://aliseda.example/venta");
    expect(views[0].tasks[0].loosened).toEqual(loosened);
  });

  it("returns an empty array when there are no tasks", () => {
    expect(buildPortalCaptureViews([], [summary("aliseda")])).toEqual([]);
  });

  it("ignores summaries for portals with no task", () => {
    const views = buildPortalCaptureViews([task("idealista")], [summary("cimenta2")]);
    expect(views).toHaveLength(1);
    expect(views[0].portal).toBe("idealista");
    expect(views[0].summary).toBeNull();
  });
});

describe("captureTotals", () => {
  it("sums counts across portals and computes the overall percentage", () => {
    const views = buildPortalCaptureViews(
      [task("idealista"), task("aliseda")],
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
    const views = buildPortalCaptureViews([task("idealista"), task("aliseda")], []);
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

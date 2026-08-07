/**
 * Unit tests for the capture-worklist pure helpers (issue #237).
 *
 * The MATCH_KEY_CASES table below is the byte-for-byte mirror of
 * etl/tests/test_capture_worklist.py's MATCH_KEY_CASES — the TypeScript
 * `worklistMatchKey` (seed-time canonicalisation) and the Python
 * `worklist_match_key` (capture-time correlation) MUST produce identical
 * output or a captured listing silently fails to correlate to its worklist
 * row. Keeping the two tables identical is the guard.
 */

import { describe, it, expect } from "vitest";
import {
  worklistMatchKey,
  portalForUrl,
  firstPendingUrl,
  pendingUrls,
  selectNextPendingUrls,
} from "@/lib/worklist";
import type {
  WorklistRow,
  WorklistStatus,
  PendingSelectionItem,
} from "@/lib/worklist";

// Mirror of etl/tests/test_capture_worklist.py MATCH_KEY_CASES.
const MATCH_KEY_CASES: [string, string][] = [
  ["https://www.alisedainmobiliaria.com/inmueble/ANT1", "alisedainmobiliaria.com/inmueble/ANT1"],
  ["http://alisedainmobiliaria.com/inmueble/ANT1/", "alisedainmobiliaria.com/inmueble/ANT1"],
  [
    "https://www.alisedainmobiliaria.com/inmueble/ANT1?utm_source=x#gallery",
    "alisedainmobiliaria.com/inmueble/ANT1",
  ],
  ["https://WWW.Idealista.com/inmueble/106387165/", "idealista.com/inmueble/106387165"],
  ["  https://alisedainmobiliaria.com/inmueble/ANT2  ", "alisedainmobiliaria.com/inmueble/ANT2"],
  ["not a url", ""],
];

describe("worklistMatchKey", () => {
  it.each(MATCH_KEY_CASES)("canonicalises %s", (url, expected) => {
    expect(worklistMatchKey(url)).toBe(expected);
  });

  it("preserves path case (asset ids can be case-sensitive)", () => {
    expect(worklistMatchKey("https://alisedainmobiliaria.com/inmueble/AbC123")).toBe(
      "alisedainmobiliaria.com/inmueble/AbC123",
    );
  });
});

describe("portalForUrl", () => {
  it("maps a known capture host to its portal", () => {
    expect(portalForUrl("https://www.alisedainmobiliaria.com/inmueble/ANT1")).toBe("aliseda");
    expect(portalForUrl("https://www.idealista.com/inmueble/1/")).toBe("idealista");
  });

  it("matches subdomains of a capture host", () => {
    expect(portalForUrl("https://foo.alisedainmobiliaria.com/inmueble/ANT1")).toBe("aliseda");
  });

  it("returns null for an unrecognised host", () => {
    expect(portalForUrl("https://www.fotocasa.es/vivienda/1")).toBeNull();
    expect(portalForUrl("not a url")).toBeNull();
  });
});

describe("firstPendingUrl — human-paced 'Siguiente' advance (issue #254)", () => {
  const row = (id: number, url: string, status: WorklistStatus): WorklistRow => ({
    id,
    url,
    source_portal: "aliseda",
    status,
    added_via: "manual",
    note: null,
    matched_capture_id: null,
    created_at: "2026-08-04T00:00:00Z",
    updated_at: "2026-08-04T00:00:00Z",
  });

  it("returns the first pending URL in list order", () => {
    const rows = [
      row(1, "https://a/inmueble/1", "captured"),
      row(2, "https://a/inmueble/2", "pending"),
      row(3, "https://a/inmueble/3", "pending"),
    ];
    expect(firstPendingUrl(rows)).toBe("https://a/inmueble/2");
  });

  it("skips captured/failed/skipped/stale rows", () => {
    // 'stale' (issue #273): a listing that left the portal's sitemap must never
    // be surfaced by "Abrir siguiente pendiente".
    const rows = [
      row(1, "https://a/inmueble/1", "captured"),
      row(2, "https://a/inmueble/2", "failed"),
      row(3, "https://a/inmueble/3", "skipped"),
      row(4, "https://a/inmueble/4", "stale"),
      row(5, "https://a/inmueble/5", "pending"),
    ];
    expect(firstPendingUrl(rows)).toBe("https://a/inmueble/5");
  });

  it("returns null when the only non-pending rows are stale", () => {
    expect(firstPendingUrl([row(1, "https://a/inmueble/1", "stale")])).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    expect(firstPendingUrl([row(1, "https://a/inmueble/1", "captured")])).toBeNull();
    expect(firstPendingUrl([])).toBeNull();
  });
});

describe("pendingUrls — the batch queue the extension sweeps (issue #262)", () => {
  const row = (id: number, url: string, status: WorklistStatus): WorklistRow => ({
    id,
    url,
    source_portal: "aliseda",
    status,
    added_via: "derived",
    external_id: null,
    note: null,
    matched_capture_id: null,
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-05T00:00:00Z",
  });

  it("returns every pending URL in list order, skipping other statuses", () => {
    const rows = [
      row(1, "https://a/inmueble/1", "captured"),
      row(2, "https://a/inmueble/2", "pending"),
      row(3, "https://a/inmueble/3", "failed"),
      row(4, "https://a/inmueble/4", "pending"),
      row(5, "https://a/inmueble/5", "skipped"),
    ];
    expect(pendingUrls(rows)).toEqual(["https://a/inmueble/2", "https://a/inmueble/4"]);
  });

  it("returns an empty array when nothing is pending", () => {
    expect(pendingUrls([row(1, "https://a/inmueble/1", "captured")])).toEqual([]);
    expect(pendingUrls([])).toEqual([]);
  });
});

describe("selectNextPendingUrls — auto-driver next batch (issue #424)", () => {
  const items: PendingSelectionItem[] = [
    { url: "u-alt", portal: "altamira", createdAt: "2026-01-01T00:00:00Z" },
    { url: "u-ide-new", portal: "idealista", createdAt: "2026-03-01T00:00:00Z" },
    { url: "u-ide-old", portal: "idealista", createdAt: "2026-02-01T00:00:00Z" },
    { url: "u-ali", portal: "aliseda", createdAt: "2026-01-15T00:00:00Z" },
  ];
  const due = { idealista: 0, aliseda: 1 }; // altamira absent → unknown (last)

  it("orders due-first then oldest, and caps at N", () => {
    expect(selectNextPendingUrls(items, due, 99)).toEqual([
      "u-ide-old",
      "u-ide-new",
      "u-ali",
      "u-alt",
    ]);
    expect(selectNextPendingUrls(items, due, 1)).toEqual(["u-ide-old"]);
    expect(selectNextPendingUrls(items, due, 0)).toEqual([]);
  });

  it("mirrors the extension: no due map → pure oldest-first", () => {
    expect(selectNextPendingUrls(items, {}, 99)).toEqual([
      "u-alt",
      "u-ali",
      "u-ide-old",
      "u-ide-new",
    ]);
  });

  it("sorts an unparseable/absent createdAt to the back", () => {
    const withBad: PendingSelectionItem[] = [
      { url: "bad", portal: "idealista", createdAt: null },
      { url: "good", portal: "idealista", createdAt: "2026-02-01T00:00:00Z" },
    ];
    expect(selectNextPendingUrls(withBad, { idealista: 0 }, 99)).toEqual(["good", "bad"]);
  });
});

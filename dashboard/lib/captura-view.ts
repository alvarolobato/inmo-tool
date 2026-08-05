/**
 * Captura (guided-capture EXECUTION) view model — pure helpers (issue #268).
 *
 * The top-level `/captura` page composes two existing, independent data
 * sources into one owner-facing, per-portal view:
 *
 *   - `GET /api/profiles/[id]/search-urls` → the profile's PRE-FILTERED search
 *     URL per capture portal, plus any constraints the portal's URL grammar had
 *     to loosen (issue #267 / lib/search-url).
 *   - `GET /api/etl/worklist` → the global per-portal worklist roll-up
 *     (pending / captured / failed / skipped counts — issue #260 / lib/worklist).
 *
 * The worklist is GLOBAL per portal, not scoped to a profile (the
 * capture_worklist table has no profile column). So a portal's progress shown
 * on the Captura page is "everything captured for that portal so far", framed
 * against the profile whose pre-filtered search opens it. This module is the
 * single place that join happens, kept pure (no `pg`, no React) so both the
 * page and its unit tests import the same logic.
 *
 * Client-safe: only type imports from lib/search-url + lib/worklist. No `pg`.
 */

import type { PortalSearchUrl } from "@/lib/search-url";
import type { WorklistPortalSummary } from "@/lib/worklist";

/**
 * One capture portal as the Captura page renders it: the profile's pre-filtered
 * search link (+ any loosened constraints) joined to that portal's worklist
 * roll-up (or null when the portal has no worklist rows yet).
 */
export interface PortalCaptureView {
  /** Portal key — matches `CAPTURE_PORTALS[].portal` in lib/worklist.ts. */
  portal: string;
  /** The profile's pre-filtered search URL for this portal. */
  searchUrl: string;
  /** Constraints the portal's URL grammar had to broaden (never narrow). */
  loosened: PortalSearchUrl["loosened"];
  /** This portal's global worklist roll-up, or null if it has no rows yet. */
  summary: WorklistPortalSummary | null;
  /** Captured share of the portal's worklist, 0–100 (0 when empty). */
  capturedPct: number;
}

/** Captured/total as an integer percentage; 0 when the portal has no rows. */
export function capturedPct(summary: WorklistPortalSummary | null): number {
  if (!summary || summary.total <= 0) return 0;
  return Math.round((summary.captured / summary.total) * 100);
}

/**
 * Join a profile's per-portal search URLs to the global worklist summaries,
 * preserving the search-URL order (which follows CAPTURE_PORTALS). One entry
 * per portal that has a pre-filtered search URL — the portals the operator can
 * actually launch a guided capture into. A portal with a URL but no worklist
 * rows yet gets `summary: null` (the card shows "aún sin lista").
 */
export function buildPortalCaptureViews(
  urls: readonly PortalSearchUrl[],
  summaries: readonly WorklistPortalSummary[],
): PortalCaptureView[] {
  const byPortal = new Map<string, WorklistPortalSummary>();
  for (const s of summaries) byPortal.set(s.source_portal, s);
  return urls.map((u) => {
    const summary = byPortal.get(u.portal) ?? null;
    return {
      portal: u.portal,
      searchUrl: u.url,
      loosened: u.loosened,
      summary,
      capturedPct: capturedPct(summary),
    };
  });
}

/**
 * Portal-wide totals across every view — powers the page's headline progress
 * strip ("N de M capturadas en P portales"). Portals with no worklist rows
 * contribute 0 to every count but still count toward `portals`.
 */
export interface CaptureTotals {
  portals: number;
  total: number;
  pending: number;
  captured: number;
  failed: number;
  skipped: number;
  capturedPct: number;
}

export function captureTotals(views: readonly PortalCaptureView[]): CaptureTotals {
  const t: CaptureTotals = {
    portals: views.length,
    total: 0,
    pending: 0,
    captured: 0,
    failed: 0,
    skipped: 0,
    capturedPct: 0,
  };
  for (const v of views) {
    if (!v.summary) continue;
    t.total += v.summary.total;
    t.pending += v.summary.pending;
    t.captured += v.summary.captured;
    t.failed += v.summary.failed;
    t.skipped += v.summary.skipped;
  }
  t.capturedPct = t.total > 0 ? Math.round((t.captured / t.total) * 100) : 0;
  return t;
}

/** Human label for a portal key (Title-case fallback for unknown portals). */
export function portalLabel(portal: string): string {
  return portal.length > 0 ? portal[0].toUpperCase() + portal.slice(1) : portal;
}

/**
 * Guided capture worklist — shared pure helpers (issue #237).
 *
 * Client-safe: no `pg` import, so both the worklist page (client component)
 * and the API routes (server) can import it. DB access lives in
 * lib/db/worklist.ts (server-only).
 */

/** A capture_worklist row as returned to the UI. */
export interface WorklistRow {
  id: number;
  url: string;
  source_portal: string;
  status: WorklistStatus;
  added_via: "sitemap" | "manual" | "derived";
  /** Portal asset id from the URL slug (sitemap-seeded rows); null otherwise. */
  external_id: string | null;
  note: string | null;
  matched_capture_id: number | null;
  created_at: string;
  updated_at: string;
}

export type WorklistStatus = "pending" | "captured" | "failed" | "skipped";

export const WORKLIST_STATUSES: readonly WorklistStatus[] = [
  "pending",
  "captured",
  "failed",
  "skipped",
];

/** Per-portal status roll-up for the worklist page header. */
export interface WorklistPortalSummary {
  source_portal: string;
  total: number;
  pending: number;
  captured: number;
  failed: number;
  skipped: number;
}

/**
 * Portals the browser extension can capture. This list is the dashboard-side
 * mirror of etl/capture.py's `_CAPTURE_CONNECTORS` — the two must stay in step
 * (adding a portal is a one-line edit in each). It is the single source served
 * to the extension via GET /api/extension/config, so the extension's
 * supported-host badge tracks new portals with no extension redeploy (Fable's
 * note on issue #237 §3).
 */
export const CAPTURE_PORTALS: readonly { portal: string; hostSuffix: string }[] = [
  { portal: "idealista", hostSuffix: "idealista.com" },
  { portal: "aliseda", hostSuffix: "alisedainmobiliaria.com" },
];

/** Bare host suffixes, for the extension config endpoint. */
export const CAPTURE_HOST_SUFFIXES: readonly string[] = CAPTURE_PORTALS.map(
  (p) => p.hostSuffix,
);

/**
 * Portals whose worklist can be seeded automatically from a public sitemap
 * (issue #260). Cimenta2 is the only one today (D-034/D-035); its sitemap
 * enumerates the full Cajamar inventory, so "Refrescar sitemap" can populate
 * its worklist without the operator pasting anything. This list is the
 * dashboard-side mirror of etl/worklist_seed.py's `_SEEDERS` — the two must
 * stay in step (adding a portal is a one-line edit in each).
 */
export const SITEMAP_SEEDABLE_PORTALS: readonly string[] = ["cimenta2"];

/**
 * Canonical correlation key linking a worklist URL to an incoming capture,
 * tolerant of cosmetic URL differences (issue #237).
 *
 * key = hostname (lowercased, leading `www.` stripped) + path (trailing slash
 * stripped). Scheme, query and fragment are dropped; path case is preserved
 * (asset ids can be case-sensitive). Returns "" for an unparseable URL.
 *
 * MUST stay identical to etl/capture.py `worklist_match_key` — both are pinned
 * by a shared (input -> expected) table asserted in this repo's TS and Python
 * suites (lib/__tests__/worklist.test.ts and etl/tests/test_capture_worklist.py).
 */
export function worklistMatchKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "";
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${host}${path}`;
}

/**
 * The capture portal a URL belongs to (by host suffix), or null if no capture
 * connector handles that host. Same hostname-suffix matching as
 * etl/capture.py's `_connector_for_url` (exact host or a subdomain of it).
 */
export function portalForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const { portal, hostSuffix } of CAPTURE_PORTALS) {
    if (host === hostSuffix || host.endsWith("." + hostSuffix)) return portal;
  }
  return null;
}

/**
 * The next `pending` worklist URL in the given list order, or null if none is
 * pending.
 *
 * History (do not "restore" the old behaviour): through #254/#260 this backed a
 * deliberately human-paced "open ONE tab per click" flow, on the reasoning that
 * rapid-firing tabs from a queue looks like bot navigation. Issue #262 (D-043)
 * supersedes that: the browser extension now drives a fully-automated
 * sequential queue itself (open → activate → auto-capture → close → advance),
 * because "click once, do nothing else" is the owner's north-star for every
 * capture connector. The WAF concern the old design named did NOT go away — it
 * moved into the extension, which keeps a JITTERED delay between pages (see the
 * extension's batch.js / D-043). This helper survives only as the fallback
 * "Abrir siguiente pendiente" affordance on the /etl/captura page for when the
 * operator wants to open one by hand.
 */
export function firstPendingUrl(rows: readonly WorklistRow[]): string | null {
  for (const r of rows) {
    if (r.status === "pending") return r.url;
  }
  return null;
}

/**
 * All `pending` worklist URLs in list order — the full queue the extension's
 * batch runner sweeps (issue #262). The extension fetches this set for a portal
 * and processes it one page at a time with jittered pacing (D-043).
 */
export function pendingUrls(rows: readonly WorklistRow[]): string[] {
  return rows.filter((r) => r.status === "pending").map((r) => r.url);
}

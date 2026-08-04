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

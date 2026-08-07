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

// 'stale' (issue #273): a sitemap-seeded row whose listing has since dropped
// out of the portal's sitemap (sold/delisted). Distinct from 'skipped' (owner
// choice) and 'failed' (a capture was attempted and didn't land). Set by
// etl/worklist_seed.py's reseed reconciliation; excluded from firstPendingUrl.
export type WorklistStatus =
  | "pending"
  | "captured"
  | "failed"
  | "skipped"
  | "stale";

export const WORKLIST_STATUSES: readonly WorklistStatus[] = [
  "pending",
  "captured",
  "failed",
  "skipped",
  "stale",
];

/** Per-portal status roll-up for the worklist page header. */
export interface WorklistPortalSummary {
  source_portal: string;
  total: number;
  pending: number;
  captured: number;
  failed: number;
  skipped: number;
  stale: number;
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
  { portal: "altamira", hostSuffix: "altamirainmuebles.com" },
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

/** A pending worklist entry for the auto-driver's next-batch selection (#424). */
export interface PendingSelectionItem {
  url: string;
  portal: string;
  /** ISO timestamp (oldest-first tiebreak); null/invalid sorts last. */
  createdAt: string | null;
}

// Portal not covered by any profile task → back of the queue, still eligible.
// Mirrors browser-extension/batch.js AUTO_PORTAL_RANK_UNKNOWN.
const PORTAL_RANK_UNKNOWN = 99;

// Rank AT OR ABOVE which a portal is NOT due this cycle (issue #434). The #414
// ranks are due=0 < half-done=1 < not-due=2 < unknown=99; a portal is "due"
// (auto should capture it now) only when it has at least one due task — rank 0
// (due) or 1 (half-done). not-due (2, al día within the staleness window) and
// unknown (99, no connector/profile → no staleness window to respect) are NOT
// due, so due-only mode skips them. Mirror of browser-extension/batch.js
// PORTAL_RANK_NOT_DUE.
export const PORTAL_RANK_NOT_DUE = 2;

/**
 * Is a portal DUE this cycle, given its #414 due-rank (or `undefined` when the
 * portal has no connector/profile)? Pure. Due ⇔ rank is finite and
 * < {@link PORTAL_RANK_NOT_DUE} (0 due, or 1 half-done). Anything else — al día
 * (2), unknown/no-connector, or a non-finite rank — is NOT due. Mirror of
 * browser-extension/batch.js `isPortalDue`.
 */
export function isPortalDue(rank: number | undefined): boolean {
  return typeof rank === "number" && Number.isFinite(rank) && rank < PORTAL_RANK_NOT_DUE;
}

/**
 * Select the next ≤`limit` pending URLs, prioritised by portal due-rank (asc —
 * from {@link getPortalDuePriority}: due 0 < half-done 1 < not-due 2 < unknown)
 * then oldest `createdAt` (asc). Pure and STABLE (input order breaks remaining
 * ties). This is the SERVER mirror of browser-extension/batch.js
 * `selectNextPending`; the two must stay in step so the endpoint and the
 * extension agree on ordering. Backs GET /api/etl/worklist?pending=1&limit=N.
 *
 * `dueOnly` (issue #434, default false): when true, FILTER OUT items whose
 * portal is not due this cycle ({@link isPortalDue}) BEFORE ranking/slicing, so
 * auto captures only work whose connector's staleness window has elapsed. An
 * empty result then signals the driver "nothing due" → it idles until the next
 * tick (never spins). `dueOnly=false` (the "Forzar" toggle) keeps the full
 * pending set so already-done / not-due listings are re-captured.
 */
export function selectNextPendingUrls(
  items: readonly PendingSelectionItem[],
  duePriorityByPortal: Readonly<Record<string, number>>,
  limit: number,
  dueOnly = false,
): string[] {
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (lim === 0) return [];
  const rankFor = (portal: string): number => {
    const r = duePriorityByPortal[portal];
    return typeof r === "number" && Number.isFinite(r) ? r : PORTAL_RANK_UNKNOWN;
  };
  const eligible = dueOnly
    ? items.filter((it) => isPortalDue(duePriorityByPortal[it.portal]))
    : items;
  const tsOf = (createdAt: string | null): number => {
    if (createdAt == null) return Number.MAX_SAFE_INTEGER;
    const t = Date.parse(createdAt);
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };
  return eligible
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ra = rankFor(a.it.portal);
      const rb = rankFor(b.it.portal);
      if (ra !== rb) return ra - rb;
      const ta = tsOf(a.it.createdAt);
      const tb = tsOf(b.it.createdAt);
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .slice(0, lim)
    .map((x) => x.it.url);
}

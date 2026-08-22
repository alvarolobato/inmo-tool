/**
 * Prospective-site capture queue — shared pure helpers (issue #705).
 *
 * "Sitios en evaluación": pages from a site inmo-tool does NOT yet support,
 * queued so the extension's auto-driver captures them from the owner's own
 * browser while it is already polling. The captured HTML lands in
 * `extension_diagnostic` (issue #671/#675, D-153) — never in `extension_capture`,
 * never in `listing`/`property`. See D-167.
 *
 * Client-safe: no `pg` import, so the /admin/diagnostics panel (client) and the
 * API routes (server) both import it. DB access lives in lib/db/spike-queue.ts.
 */

import { portalForUrl, worklistMatchKey } from "./worklist";

/**
 * Terminal states. There is deliberately **no `failed`**: capturing a page from
 * a site we don't support is a clean outcome, not an ingestion error, and it
 * must never show up as one in data-health. Same precedent as
 * `extension_capture`'s own `listing` (#292) and `blocked` (#692) — each a
 * distinct terminal state rather than an overloaded `failed`.
 *
 *   pending      — queued, waiting for the driver (or for its host permission)
 *   captured     — a page landed; `matched_diagnostic_id` points at it
 *   skipped      — the operator dropped it
 *   unreachable  — the server HANDED this row to the driver MAX_ATTEMPTS times
 *                  and no page ever came back (tab never loaded, page never
 *                  rendered). A finding ABOUT the candidate site, which is the
 *                  point of a spike.
 *
 * A missing host permission is deliberately NOT a route to `unreachable`: a
 * row whose origin the driver cannot open is never handed out in the first
 * place (see {@link grantableSpikeOrigins} and the planner's claim), so it
 * stays `pending`, keeps the popup's grant button visible, and burns no
 * attempts. "You didn't click the popup in time" is not a finding about the
 * candidate site.
 */
export type SpikeStatus = "pending" | "captured" | "skipped" | "unreachable";

export const SPIKE_STATUSES: readonly SpikeStatus[] = [
  "pending",
  "captured",
  "skipped",
  "unreachable",
];

/** A capture_spike_request row as returned to the UI. */
export interface SpikeRequestRow {
  id: number;
  url: string;
  host: string;
  /** `scheme://hostname` (no port) — the host-permission scope for this row. */
  origin: string;
  site_label: string;
  note: string | null;
  status: SpikeStatus;
  matched_diagnostic_id: number | null;
  attempts: number;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * How many times a single request is handed to the driver before it is given
 * up on as `unreachable`. Three, not one: a candidate site's first load can
 * lose to a cold cache or a consent wall the owner then dismisses, and
 * re-queueing by hand is exactly the friction this feature exists to remove.
 */
export const MAX_SPIKE_ATTEMPTS = 3;

/**
 * Hard cap on simultaneously-`pending` requests. The queue is meant to hold "a
 * handful of URLs from one candidate site", and every one of them eventually
 * becomes a ~350 KB row in `extension_diagnostic`. Refusing past the cap is the
 * queue-side half of the retention story (the other half is
 * purge_extension_diagnostics(), wired to the ETL scheduler by this issue).
 *
 * It is ALSO what bounds how long a `spike` unit can preempt the listing
 * drain — see {@link SPIKE_UNIT_LIMIT} for the arithmetic, and note that the
 * two constants only make sense read together.
 */
export const MAX_PENDING_SPIKE_REQUESTS = 50;

/**
 * How many spike URLs one auto unit carries.
 *
 * THE REAL WORST CASE, stated rather than hand-waved. A `spike` unit PREEMPTS
 * harvest/drain, so with a full queue of pages that render nothing, Auto does
 * no listing work for
 *
 *   ceil(MAX_PENDING_SPIKE_REQUESTS / SPIKE_UNIT_LIMIT) × MAX_SPIKE_ATTEMPTS
 *     = ceil(50 / 5) × 3 = 30 ticks ≈ 30 min at the default 60 s tick
 *
 * and longer if the pages DO render (each unit then also costs a page load and
 * a dwell per URL). That is bounded, operator-triggered and self-clearing —
 * every tick permanently consumes one attempt per delivered row, because the
 * counter is bumped by the delivery statement itself — but it is thirty
 * minutes, not "a couple of ticks". `MAX_PENDING_SPIKE_REQUESTS` was lowered
 * from 200 to 50 precisely to keep that number inside a coffee break.
 *
 * Rows whose origin has no host permission are never delivered at all, so an
 * unpermitted queue costs the drain nothing.
 */
export const SPIKE_UNIT_LIMIT = 5;

export interface SpikeUrlRejection {
  url: string;
  reason: string;
}

export interface SpikeUrlValidation {
  /** Accepted URLs, de-duplicated by match key, with their derived fields. */
  accepted: { url: string; matchKey: string; host: string; origin: string }[];
  rejected: SpikeUrlRejection[];
}

/**
 * The host-permission scope of a URL: `scheme://hostname`, port dropped.
 *
 * A Chrome match pattern has no port component — `https://foo.test:8443/*` is
 * REJECTED by chrome.permissions.request(), and a grant on
 * `http://localhost/*` covers every port on localhost. So the port must be
 * dropped here or the popup would ask for a pattern Chrome refuses, and the
 * planner would compare a ported origin against a portless grant and never
 * match. Returns "" for an unparseable URL.
 */
export function spikePermissionOrigin(url: string): string {
  try {
    const u = new URL(String(url).trim());
    if (!u.hostname) return "";
    return `${u.protocol}//${u.hostname.toLowerCase()}`;
  } catch {
    return "";
  }
}

/**
 * Hosts the spike queue refuses outright, whatever else is true of them.
 *
 * The threat this closes is not a hostile operator, it is an ordinary typo
 * plus an unfortunate manifest fact: `manifest.json` pre-declares
 * `http://localhost/*` and `http://127.0.0.1/*`, and **Chrome match patterns
 * ignore the port**, so `http://localhost:4000/admin/diagnostics` is already
 * granted, with no prompt. Queue it and the driver opens the dashboard's own
 * authenticated admin UI in a tab carrying the `ps_admin` cookie and uploads
 * the rendered page — the operator's own session, filed as a "candidate site
 * sample". Private-range and `.local` hosts are the same class of mistake
 * aimed at an intranet instead.
 *
 * #675's manual button answered this class with a `confirm()` naming the URL;
 * an automated driver has no such moment, so the refusal moves to seed time.
 */
const DENIED_HOST_EXACT = new Set([
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

/** Loopback / link-local / RFC1918 / CGNAT literals, plus .local and .localhost. */
function isDeniedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (DENIED_HOST_EXACT.has(h) || DENIED_HOST_EXACT.has(host.toLowerCase())) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8")) return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

export interface SpikeValidationOptions {
  /**
   * Extra hosts to refuse — the dashboard's OWN host, as seen by the request
   * being served. Passed in rather than read from the environment so this
   * module stays client-safe and pure.
   */
  deniedHosts?: readonly string[];
}

/**
 * Validate a batch of pasted URLs for the spike queue.
 *
 * The mirror image of `addWorklistUrls`' validation, and deliberately so: that
 * one requires `portalForUrl(url)` to RESOLVE, this one requires it to be
 * NULL. The two paste boxes are therefore mutually exclusive by host — a
 * mistyped idealista link is refused here ("that host already has a
 * connector") and an unknown host is refused there, so neither box can quietly
 * accept what belongs in the other. That mutual exclusion, not a checkbox, is
 * what makes "this is a new site I'm evaluating" an explicit choice.
 */
export function validateSpikeUrls(
  urls: readonly string[],
  opts: SpikeValidationOptions = {},
): SpikeUrlValidation {
  const accepted: { url: string; matchKey: string; host: string; origin: string }[] = [];
  const rejected: SpikeUrlRejection[] = [];
  const seen = new Set<string>();
  const extraDenied = new Set(
    (opts.deniedHosts ?? [])
      .map((h) => String(h || "").trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean),
  );

  for (const raw of urls) {
    const url = String(raw || "").trim();
    if (!url) continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      rejected.push({ url, reason: "URL inválida" });
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      rejected.push({ url, reason: "Solo se admiten URLs http(s)" });
      continue;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (isDeniedHost(hostname) || extraDenied.has(hostname)) {
      rejected.push({
        url,
        reason:
          "Host no permitido (el propio panel, localhost o una red privada) — la extensión lo abriría con tu sesión iniciada",
      });
      continue;
    }

    const portal = portalForUrl(url);
    if (portal) {
      rejected.push({
        url,
        reason: `Ese host ya tiene conector (${portal}) — usa la lista de captura de /admin/fuentes/${portal}`,
      });
      continue;
    }

    const matchKey = worklistMatchKey(url);
    if (!matchKey) {
      rejected.push({ url, reason: "No se pudo derivar la clave de correlación" });
      continue;
    }
    if (seen.has(matchKey)) continue; // in-batch duplicate, silently collapsed
    seen.add(matchKey);

    accepted.push({
      url,
      matchKey,
      host: hostname.replace(/^www\./, ""),
      origin: `${parsed.protocol}//${hostname}`,
    });
  }

  return { accepted, rejected };
}

/**
 * The distinct origins a grant would unblock. This is what the extension's
 * popup asks `chrome.permissions.request()` for: `optional_host_permissions`
 * covers `http(s)://*​/*` but Chrome only grants an origin from a real user
 * gesture on an extension page, so the popup collects them and prompts once.
 *
 * `unreachable` rows count too, not just `pending` ones. A batch that was
 * given up on is exactly when the operator most needs the grant button and the
 * amber banner still to be there — deriving the affordance from `pending`
 * alone made it vanish at the moment it became necessary.
 */
export function grantableSpikeOrigins(rows: readonly SpikeRequestRow[]): string[] {
  const origins = new Set<string>();
  for (const r of rows) {
    if (r.status !== "pending" && r.status !== "unreachable") continue;
    const origin = r.origin || spikePermissionOrigin(r.url);
    if (origin) origins.add(origin);
  }
  return [...origins].sort();
}

/** Per-site roll-up for the /admin/diagnostics panel. */
export interface SpikeSiteSummary {
  site_label: string;
  total: number;
  pending: number;
  captured: number;
  skipped: number;
  unreachable: number;
}

/** Group rows by their operator-given site label. Pure; input order preserved. */
export function summarizeSpikeRequests(
  rows: readonly SpikeRequestRow[],
): SpikeSiteSummary[] {
  const bySite = new Map<string, SpikeSiteSummary>();
  for (const r of rows) {
    let s = bySite.get(r.site_label);
    if (!s) {
      s = {
        site_label: r.site_label,
        total: 0,
        pending: 0,
        captured: 0,
        skipped: 0,
        unreachable: 0,
      };
      bySite.set(r.site_label, s);
    }
    s.total += 1;
    s[r.status] += 1;
  }
  return [...bySite.values()];
}

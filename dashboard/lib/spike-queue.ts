/**
 * Prospective-site capture queue — shared pure helpers (issue #705).
 *
 * "Sitios en evaluación": pages from a site inmo-tool does NOT yet support,
 * queued so the extension's auto-driver captures them from the owner's own
 * browser while it is already polling. The captured HTML lands in
 * `extension_diagnostic` (issue #671/#675, D-153) — never in `extension_capture`,
 * never in `listing`/`property`. See D-164.
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
 *   unreachable  — MAX_ATTEMPTS opens produced no page (tab never loaded, page
 *                  never rendered, permission never granted). A finding ABOUT
 *                  the candidate site, which is the point of a spike.
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
 * How many opens a single request gets before it is given up on as
 * `unreachable`. Three, not one: a candidate site's first load can lose to a
 * cold cache or a consent wall the owner then dismisses, and re-queueing by
 * hand is exactly the friction this feature exists to remove.
 */
export const MAX_SPIKE_ATTEMPTS = 3;

/**
 * Hard cap on simultaneously-`pending` requests. The queue is meant to hold "a
 * handful of URLs from one candidate site", and every one of them eventually
 * becomes a ~350 KB row in `extension_diagnostic`. Refusing past the cap is the
 * queue-side half of the retention story (the other half is
 * purge_extension_diagnostics(), wired to the ETL scheduler by this issue).
 */
export const MAX_PENDING_SPIKE_REQUESTS = 200;

/**
 * How many spike URLs one auto unit carries. Small on purpose: a `spike` unit
 * PREEMPTS harvest/drain (the operator queued these seconds ago and wants them
 * now), so it must never be able to stall the owner's real listing drain for
 * more than a few ticks. See {@link https://github.com/alvarolobato/inmo-tool/issues/705}.
 */
export const SPIKE_UNIT_LIMIT = 5;

export interface SpikeUrlRejection {
  url: string;
  reason: string;
}

export interface SpikeUrlValidation {
  /** Accepted URLs, de-duplicated by match key, with their derived fields. */
  accepted: { url: string; matchKey: string; host: string }[];
  rejected: SpikeUrlRejection[];
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
export function validateSpikeUrls(urls: readonly string[]): SpikeUrlValidation {
  const accepted: { url: string; matchKey: string; host: string }[] = [];
  const rejected: SpikeUrlRejection[] = [];
  const seen = new Set<string>();

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
      host: parsed.hostname.toLowerCase().replace(/^www\./, ""),
    });
  }

  return { accepted, rejected };
}

/**
 * The distinct hosts still waiting on the driver. This is what the extension's
 * popup asks `chrome.permissions.request()` for: `optional_host_permissions`
 * covers `http(s)://*​/*` but Chrome only grants an origin from a real user
 * gesture on an extension page, so the popup collects them and prompts once.
 */
export function pendingSpikeOrigins(rows: readonly SpikeRequestRow[]): string[] {
  const origins = new Set<string>();
  for (const r of rows) {
    if (r.status !== "pending") continue;
    try {
      origins.add(new URL(r.url).origin);
    } catch {
      /* a stored row that no longer parses can't be granted — skip it */
    }
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

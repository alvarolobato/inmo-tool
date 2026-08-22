/**
 * Data-health / observability — shared pure helpers (issue #272).
 *
 * Client-safe: no `pg` import, so both the "Salud de datos" page (client
 * component) and the API route (server) can import the types and the
 * classification helpers. DB access lives in lib/db/data-health.ts
 * (server-only), same split as lib/worklist.ts ↔ lib/db/worklist.ts.
 *
 * The one judgement call this whole surface turns on: a connector that stops
 * cleanly for a budget cap or a soft-block (#270/#300) reports `status='ok'`
 * with a `nota:` notice in error_msg — that is HEALTHY, not an error. Only
 * `circuit_open` / `failed` are attention-worthy. `connectorHealthLevel` and
 * `hasCleanNotice` encode exactly that distinction so the UI can render a
 * clean budget stop green-with-an-info-note instead of red.
 */

import { CAPTURE_PORTALS } from "./worklist";
import type { ZeroResultRegression } from "./zero-result-regression";

export type { ZeroResultRegression } from "./zero-result-regression";

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * A pending capture older than this (seconds) is "stuck". The poll loop
 * (etl/capture.py `run_capture_poll_loop`, interval 10s) clears a healthy
 * backlog in ~10s; 300s is 30× that — generous headroom against a slow batch,
 * so anything past it is a real signal (disabled connector, a capture bug
 * throwing before `_mark_failed`, etc.). Issue #272 EC-2.
 */
export const STUCK_PENDING_SECONDS = 300;

/**
 * A source whose successfully-stored listings carry fewer than this many
 * photos on average is under-extracting (the #266/#282 "1 photo captured vs.
 * 95 available" class). Flagged, not hidden.
 */
export const LOW_PHOTO_THRESHOLD = 3;

// ─── Types ───────────────────────────────────────────────────────────────────

/** A connector run result's status vocabulary (post-#300 clean semantics). */
export type ConnectorRunStatus = "ok" | "circuit_open" | "failed" | "skipped";

/** Per-connector last-run health (one row per connector, its latest run). */
export interface ConnectorHealth {
  connector_name: string;
  last_status: ConnectorRunStatus | string;
  last_run_at: string | null;
  discovered_count: number;
  fetched_count: number;
  error_count: number;
  skipped_count: number;
  /** error_count of the run before the latest (trend), or null if none. */
  prev_error_count: number | null;
  /**
   * The clean-stop notice (budget/soft-block) when `last_status === 'ok'` and
   * error_msg is set — surfaced as an INFO note, never as an error. Null when
   * there is no notice.
   */
  notice: string | null;
  /** The genuine error message when the last run needs attention. */
  error_msg: string | null;
  /**
   * Mean milliseconds of real work per listing on the last run (issue #700):
   * `fetch_ms_total / fetched_count`, i.e. fetch_detail + normalize + upsert,
   * with rate-limit sleep already excluded at the write site. This is the
   * CRAWLED-portal counterpart to the capture path's median_processing_ms_7d.
   *
   * Null when the run fetched nothing (no denominator) — never 0, which would
   * read as "instant" for what is really "didn't run". Note this is a mean,
   * not a median: only the per-run total is stored, so the distribution is not
   * recoverable. Good enough to compare portals by order of magnitude, which
   * is the question being asked; not good enough to chase one slow listing.
   */
  ms_per_listing: number | null;
}

/** Per-portal capture health (extension_capture aggregated by url host). */
export interface PortalCaptureHealth {
  portal: string;
  pending_count: number;
  /** Age (seconds) of the oldest pending capture, or null if none pending. */
  oldest_pending_age_seconds: number | null;
  done_7d: number;
  failed_7d: number;
  /**
   * Search/listing pages captured over the 7d window (issue #292). A clean,
   * informational outcome — the owner captured a results page and its detail
   * links were harvested into the batch worklist. NEVER counted as a failure
   * (it is not in `failed_7d`); surfaced as a neutral note, not amber/red.
   */
  listing_7d: number;
  /** Avg fields_extracted/fields_available over the 7d window, or null. */
  avg_fields_ratio_7d: number | null;
  /** Avg photo count per done capture over the 7d window, or null. */
  avg_photo_count_7d: number | null;
  /**
   * ── Per-listing timing (issue #700) ──────────────────────────────────────
   * Medians, not means: capture durations are long-tailed (one 20s render
   * behind a cold CDN drags a mean that a median shrugs off), and the owner's
   * question is "how long does a listing normally take", not "what is the
   * arithmetic mean including outliers". All three are null when the 7d window
   * holds no measured sample — null renders "—", and MUST NOT render as 0.
   *
   * The three add up to the wall time the owner actually experiences, and are
   * kept apart precisely because ONE of them is idle and the other two are
   * not:
   */
  /**
   * How long the browser extension waited for the page to render before it
   * could snapshot the DOM. On a client-rendered portal this is the dominant
   * term and the one worth fixing. Null for captures from an extension build
   * that doesn't report it, or from the manual/forced path that never waits.
   */
  median_render_wait_ms_7d: number | null;
  /**
   * How long the capture then sat in `extension_capture` before the ETL poll
   * picked it up. PURE IDLE — `run_capture_poll_loop` ticks every 10s, so this
   * is ~U(0,10)s by construction and its median sits near 5s no matter how
   * fast or slow the portal is. Surfaced *as* idle so nobody mistakes it for
   * portal slowness again (measured live: Hipoges 5.3s vs Idealista 5.8s —
   * two samples of half the poll interval, and the reason "hipoges tarda
   * mucho por anuncio" was unanswerable from stored data).
   */
  median_queue_wait_ms_7d: number | null;
  /**
   * How long the ETL then spent actually processing it (normalize + upsert).
   * Real server work, and in practice the smallest of the three.
   */
  median_processing_ms_7d: number | null;
}

/** Per-source stored-listing data quality. */
export interface SourceDataQuality {
  source: string;
  listing_count: number;
  avg_photo_count: number | null;
}

/** A profile whose newest data is newer than its last materialization. */
export interface StaleProfile {
  id: number;
  name: string;
  last_materialized_at: string | null;
  newest_listing_at: string | null;
}

/**
 * A browser-extension block/challenge episode (issue #634) — the extension
 * detected a CAPTCHA/WAF challenge on a capture portal, paused its run, and
 * reported it via POST /api/extension/block-episode. `signature` is a marker
 * id only (e.g. 'captcha_wall'), never page content. Reported the same way a
 * connector's own soft-block is (D-047): an informational notice, never a
 * red/failed badge — see `extensionBlockNoticeEs`.
 */
export interface ExtensionBlockEpisode {
  portal: string;
  signature: string;
  detected_at: string;
  /**
   * When the portal was next observed SERVING us a page, proving the wall was
   * gone — or null while no such evidence exists yet (issue #711, D-169).
   *
   * `extension_block_episode` has no resolution column and no writer that
   * closes an episode: the owner clears the wall by hand in their browser,
   * which is how the feature is meant to work, and nothing reports it back.
   * So resolution is DERIVED, at read time, from the capture ledger — see
   * `getRecentBlockEpisodes` for the SQL and D-169 for which capture outcomes
   * count as "the portal served us the page". Deriving it means it can never
   * drift out of step with the evidence, and it needed no schema change, no
   * new writer and no extension change.
   *
   * Non-null does NOT mean "nothing is wrong with this portal" — only that
   * THIS episode's wall is over. A later wall is a later episode.
   */
  resolved_at: string | null;
}

export interface DataHealthResponse {
  connectors: ConnectorHealth[];
  portals: PortalCaptureHealth[];
  sources: SourceDataQuality[];
  stale_profiles: StaleProfile[];
  /**
   * (connector, resolved scope/filter) pairs that used to return listings and
   * have now returned 0 for N consecutive runs (issue #376) — the "a search
   * stopped returning results, likely filter/URL drift" signal. Empty is the
   * healthy state. A scope that was always 0 (sparse area) or dropped to 0 only
   * once (transient) is deliberately NOT here; a later non-zero run clears it.
   */
  zero_result_regressions: ZeroResultRegression[];
  /**
   * True when a connector sweep is currently running. While a sweep runs,
   * `last_seen_at` is bumped incrementally on the mirror before
   * `last_materialized_at` has caught up, so an unguarded staleness check
   * would flag essentially every active profile (the reconciler's own
   * `_sweep_in_progress` guard, #285). When true the stale-profiles check is
   * NOT evaluated — `stale_profiles` is empty and the UI annotates the
   * section as "no evaluable durante sweep" rather than crying wolf.
   */
  sweep_in_progress: boolean;
  /**
   * Recent extension block/challenge episodes (issue #634, newest first,
   * bounded — see getRecentBlockEpisodes). Empty is the healthy state.
   */
  extension_blocks: ExtensionBlockEpisode[];
  generated_at: string;
}

// ─── Pure classification helpers ─────────────────────────────────────────────

export type ConnectorHealthLevel = "healthy" | "attention";

/**
 * Whether a connector's last run needs the operator's attention. Only a
 * genuine breaker trip (`circuit_open`) or a discover failure (`failed`) is
 * attention-worthy. `ok` (including budget/soft-block clean stops) and
 * `skipped` (disabled/uncovered) are healthy — the owner's #270 principle.
 */
export function connectorHealthLevel(status: string): ConnectorHealthLevel {
  return status === "circuit_open" || status === "failed"
    ? "attention"
    : "healthy";
}

/**
 * True when a healthy connector run carries an informational notice (a clean
 * budget/soft-block stop, `status='ok'` + a `nota:` message). This is the
 * signal to render an INFO badge, NOT a red error. A run that is already at
 * `attention` level does not get a "clean notice".
 */
export function hasCleanNotice(status: string, notice: string | null): boolean {
  return connectorHealthLevel(status) === "healthy" && !!notice && notice.trim().length > 0;
}

/**
 * True when the oldest pending capture has been waiting longer than
 * STUCK_PENDING_SECONDS. Strictly greater — exactly at the threshold is not
 * yet stuck (issue #272 EC-2: "more than 5 minutes").
 */
export function isStuckPending(oldestPendingAgeSeconds: number | null): boolean {
  return oldestPendingAgeSeconds !== null && oldestPendingAgeSeconds > STUCK_PENDING_SECONDS;
}

/**
 * Capture success rate over the window as a 0–1 fraction: done / (done +
 * failed). Null when there were no terminal captures at all (can't divide).
 */
export function captureSuccessRate(done: number, failed: number): number | null {
  const total = done + failed;
  if (total <= 0) return null;
  return done / total;
}

/**
 * How recent a block episode must be to count as an ACTIVE block (issue #642
 * P2, D-168).
 *
 * `extension_block_episode` records a detection, never a resolution — there is
 * no "cleared" row to wait for, because the block clears in the owner's
 * browser (solve the challenge, press "Reanudar" in the popup) and nothing
 * reports that back.
 *
 * This window is therefore an UPPER bound on how long an unresolved block
 * stays interesting — never the whole answer to "is it blocked right now".
 * That was issue #711: for three hours the board told the owner idealista was
 * walled while the row directly below it showed idealista ingesting, because
 * recency was the only bound there was. `resolved_at` (D-169) is the other
 * bound, and it is the one that carries evidence; this one only expires an
 * episode nothing has contradicted yet. Both must pass.
 *
 * 24 h, for two reasons that pull in the same direction:
 *   - Too short and a block detected overnight is already "history" by the
 *     time the owner looks in the morning — the exact state that most needs
 *     the chip. Capture is owner-paced and bursty (measured: 2,175 captures
 *     one day, zero on several others), so "recent" on this surface has to be
 *     measured in days, not minutes.
 *   - Too long and the chip stops meaning anything: a portal that challenged
 *     once last week is not currently blocked, and a permanently-lit chip is
 *     one nobody reads.
 * A stale chip is cheap here (it points at the same page the operator wanted
 * anyway); a missing one is not.
 */
export const ACTIVE_BLOCK_WINDOW_HOURS = 24;

/**
 * The most recent UNRESOLVED block episode per portal that falls inside
 * {@link ACTIVE_BLOCK_WINDOW_HOURS}, keyed by portal.
 *
 * Two independent bounds, both required (issue #711, D-169):
 *
 *   1. **Not contradicted** — `resolved_at` is null. A non-null value means
 *      the portal has since served us a page, which is first-hand evidence
 *      the wall is down. Evidence beats the clock, always and in both
 *      directions: D-157 says elapsed time may only NOMINATE a listing for
 *      verification and evidence decides whether it is gone; this is the same
 *      rule pointed the other way, where evidence CLEARS a state that elapsed
 *      time would otherwise keep asserting forever.
 *   2. **Not expired** — inside the recency window, for an episode nothing
 *      has contradicted yet.
 *
 * Checked in that order on purpose: resolution is a fact about this episode,
 * the window is a guess about episodes we know nothing more about.
 *
 * A resolved episode is not filtered out of EXISTENCE — Actividad's `bloqueo`
 * rows (#706) render the same episode as history and must keep doing so. This
 * function answers "is this portal walled right now", which is a different
 * question with a different answer.
 *
 * `episodes` is expected newest-first (`getRecentBlockEpisodes` orders that
 * way) but this does not rely on it — it keeps the newest per portal
 * explicitly, so a caller that re-sorts cannot silently change the answer.
 * `now` is injected so the derivation is testable without faking the clock.
 */
export function activeBlocksByPortal(
  episodes: ExtensionBlockEpisode[],
  now: number = Date.now(),
): Map<string, ExtensionBlockEpisode> {
  const cutoff = now - ACTIVE_BLOCK_WINDOW_HOURS * 3600_000;

  // Pass 1 — the NEWEST episode per portal, and nothing else. Both filters are
  // deliberately held back to pass 2: they are questions about a portal's
  // current state, and a portal's current state is described by its newest
  // episode, never by an older one that happens to survive the filter. Doing
  // it in one pass looks tidier and is wrong — a portal whose newest episode
  // is resolved, with an older unresolved one still inside the window, would
  // fall back to the older row and pin an alarm that its own newest evidence
  // has already retracted. (The SQL feeds one row per portal, so this cannot
  // arise today; the contract that this function does not depend on its
  // caller's shaping is the point, and the unit test pins it.)
  const byPortal = new Map<string, ExtensionBlockEpisode>();
  for (const ep of episodes) {
    const at = new Date(ep.detected_at).getTime();
    if (Number.isNaN(at)) continue;
    const seen = byPortal.get(ep.portal);
    if (!seen || new Date(seen.detected_at).getTime() < at) byPortal.set(ep.portal, ep);
  }

  // Pass 2 — is that newest episode still a live claim? Resolved beats the
  // clock; expiry only retires an episode nothing has contradicted.
  for (const [portal, ep] of byPortal) {
    // Truthiness, not `!== null`, on purpose: anything that is not a real
    // timestamp (null, absent, empty) means NO clearing evidence, which must
    // keep the alarm up. Every ambiguity here has to fail toward alarming.
    if (ep.resolved_at || new Date(ep.detected_at).getTime() < cutoff) {
      byPortal.delete(portal);
    }
  }
  return byPortal;
}

/**
 * Zero-result regressions grouped by the connector they belong to (issue #642
 * P2). The list itself is rendered per-source on Fuentes/<name>; Estado only
 * needs to know WHICH sources currently have one and how many, so it can show
 * an aviso chip that links there instead of restating the rows.
 */
export function zeroResultsByConnector(
  rows: ZeroResultRegression[],
): Map<string, ZeroResultRegression[]> {
  const byConnector = new Map<string, ZeroResultRegression[]>();
  for (const row of rows) {
    const list = byConnector.get(row.connector);
    if (list) list.push(row);
    else byConnector.set(row.connector, [row]);
  }
  return byConnector;
}

/**
 * True when a source's average photo count is a real number below the
 * under-extraction threshold. Null (no data) is not a flag.
 */
export function isLowPhotoCoverage(avgPhotoCount: number | null): boolean {
  return avgPhotoCount !== null && avgPhotoCount < LOW_PHOTO_THRESHOLD;
}

/**
 * True when a profile's data is newer than its last materialization — the
 * Estepona-class staleness (#285 self-heals it; surfacing it is the point). A
 * never-materialized profile (null) with any data present is stale.
 */
export function isStaleProfile(
  lastMaterializedAt: string | null,
  newestListingAt: string | null,
): boolean {
  if (!newestListingAt) return false;
  if (!lastMaterializedAt) return true;
  return new Date(lastMaterializedAt).getTime() < new Date(newestListingAt).getTime();
}

/**
 * Map a bare url host (lowercased, no leading `www.`) to a known capture
 * portal name, falling back to the host itself when it isn't a recognised
 * capture portal. Mirrors `portalForUrl` but works from an already-extracted
 * host (the SQL aggregate groups by host, not full url).
 */
export function hostToPortal(host: string): string {
  const h = host.trim().toLowerCase().replace(/^www\./, "");
  if (!h) return "desconocido";
  for (const { portal, hostSuffix } of CAPTURE_PORTALS) {
    if (h === hostSuffix || h.endsWith("." + hostSuffix)) return portal;
  }
  return h;
}

/**
 * Spanish labels for the block-signature ids browser-extension/detect.js's
 * `detectBlockSignals` reports (issue #634) — mirrors the extension's own
 * copy in popup.js (the two can't share a module across the extension/
 * dashboard boundary; both fall back to the raw id for an id neither list
 * knows yet, so a new signature always renders SOMETHING).
 */
const BLOCK_SIGNATURE_LABELS_ES: Record<string, string> = {
  cloudflare_challenge: "reto Cloudflare",
  captcha_wall: "muro CAPTCHA",
  geetest_challenge: "reto GeeTest",
  incapsula_challenge: "reto Incapsula",
  akamai_deny: "bloqueo Akamai",
};

/**
 * The informational notice line for one extension block episode — D-047
 * vocabulary ("nota:", never an error): the extension detected a challenge,
 * paused itself, and this is a clean stop the operator should go resolve.
 */
export function extensionBlockNoticeEs(episode: ExtensionBlockEpisode): string {
  const label = BLOCK_SIGNATURE_LABELS_ES[episode.signature] || episode.signature;
  return `nota: captura de ${episode.portal} pausada por bloqueo (${label})`;
}

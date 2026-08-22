/**
 * Re-capture cohort selection — shared pure helpers (issue #677).
 *
 * Client-safe: no `pg` import, so the worklist page (a client component) and
 * the API route (server) share one definition of the predicate vocabulary and
 * one cost model. DB access lives in lib/db/recapture.ts (server-only).
 *
 * Why this exists: when a parser bug leaves a cohort of listings holding bad
 * data, the listings already have `capture_worklist` rows sitting at
 * 'captured', and the extension batch driver (D-043) already drains 'pending'
 * rows. Re-capture is therefore a requeue, not a new subsystem — see the
 * `capture_worklist` requeue-column comment in etl/schema/init.sql.
 */

/**
 * The closed set of cohort predicates. Deliberately small and explicit: the
 * owner's case today is "Idealista listings with fewer than N photos", the
 * next one will be different, but the answer to that is another named
 * predicate here — NOT a SQL console reachable from a browser.
 */
export type RecapturePredicate =
  "few_photos" | "stale_capture" | "never_requeued";

export const RECAPTURE_PREDICATES: readonly RecapturePredicate[] = [
  "few_photos",
  "stale_capture",
  "never_requeued",
];

/** Spanish UI label + the unit its threshold is measured in. */
export const RECAPTURE_PREDICATE_LABEL: Record<
  RecapturePredicate,
  { label: string; unit: string | null; defaultThreshold: number | null }
> = {
  few_photos: {
    label: "Menos de N fotos",
    unit: "fotos",
    defaultThreshold: 4,
  },
  stale_capture: {
    label: "Capturado hace más de N días",
    unit: "días",
    defaultThreshold: 30,
  },
  never_requeued: {
    label: "Nunca recapturado",
    unit: null,
    defaultThreshold: null,
  },
};

export function isRecapturePredicate(v: unknown): v is RecapturePredicate {
  return (
    typeof v === "string" &&
    (RECAPTURE_PREDICATES as readonly string[]).includes(v)
  );
}

/** What the operator asked for. Resolved server-side; never trusted as a row list. */
export interface RecaptureCohortRequest {
  portal: string;
  predicate: RecapturePredicate;
  /** Meaning depends on the predicate; ignored by `never_requeued`. */
  threshold: number | null;
  /**
   * Restrict to listings whose property is a live, unrejected candidate in at
   * least one non-archived search profile. Default on: re-capturing a listing
   * nobody will ever look at is wasted browsing.
   */
  onlyLiveCandidates: boolean;
}

/** What the preview tells the operator before anything is written. */
export interface RecaptureCohortPreview {
  request: RecaptureCohortRequest;
  /**
   * `connector_config.capture_enabled` for the portal — whether the ETL would
   * actually PROCESS what a re-capture pass produces. Attached by the API
   * route, not by `previewRecaptureCohort`, hence optional: false means the
   * browsing would happen and every capture would sit `pending` forever.
   */
  captureProcessingEnabled?: boolean;
  /** Worklist rows that would flip to 'pending'. */
  rowCount: number;
  /** Listings the predicate matched, before intersecting with the worklist. */
  listingCount: number;
  /** How many of `rowCount` have been requeued at least once already. */
  alreadyRequeuedCount: number;
  estimate: RecaptureEstimate;
}

export interface RecaptureEstimate {
  /** Wall-clock seconds of continuous browser time, at the extension's pacing. */
  seconds: number;
  /** Mean seconds per listing across the whole run (not the opening cadence). */
  secondsPerListing: number;
  /**
   * Bytes `extension_capture.html` would grow by, as stored (post-TOAST), or 0
   * when the portal is not retaining HTML. Measured from this database's own
   * recent captures, not assumed — see lib/db/recapture.ts.
   */
  storedHtmlBytes: number;
  /** The same in uncompressed page bytes, which is what the operator "sees". */
  rawHtmlBytes: number;
  /** False when no recent capture for this portal kept its HTML. */
  htmlRetentionOn: boolean;
}

// ── Pacing model ────────────────────────────────────────────────────────────
// Mirrors browser-extension/batch.js `jitterDelay` / `paceBaseMs`. These are a
// COPY of the extension's dials, and this module cannot import batch.js (it is
// a CommonJS extension module, and this file is bundled into the client), so
// the copy is pinned instead: `dashboard/__tests__/extension-batch.test.ts`
// imports the REAL batch.js and asserts each of the five values below against
// it — the two exported defaults directly, the three step constants re-derived
// from the shipped `paceBaseMs()`. If batch.js's pacing moves and these don't,
// that test goes red rather than the estimate silently lying to the operator
// about an overnight-scale commitment.
//
// Exported solely so that test can reach them; nothing else should read them.
//
// Note these are the extension's DEFAULTS. An operator who has changed
// `batchPaceBaseMs`/`batchPaceSpreadMs` in the extension's own settings gets a
// run that is faster or slower than this estimate, and the panel says so.
//
// Throughput is governed by the launch stagger, NOT by the per-page dwell:
// concurrency (default 3) overlaps the settle time of pages already open, but
// the loop still only launches one new tab per jittered delay.
export const PACE_BASE_MS = 2000; // batch.js DEFAULT_PACE_BASE_MS
export const PACE_SPREAD_MS = 5000; // batch.js DEFAULT_PACE_SPREAD_MS
export const PACE_STEP_EVERY = 25; // batch.js PACE_STEP_EVERY
export const PACE_STEP_MS = 2000; // batch.js PACE_STEP_MS
export const PACE_MAX_EXTRA_MS = 12000; // batch.js PACE_MAX_EXTRA_MS

/**
 * Seconds of continuous browser time to drain `pages` listings at the
 * extension's default pacing, including its long-run backoff (the stagger base
 * grows +2 s every 25 settled pages, capped at +12 s — so a long run settles
 * at ~16.5 s/listing, nearly four times the opening cadence).
 *
 * Closed-form over the step function rather than a per-page loop, so a
 * 3,000-row preview costs nothing.
 */
export function estimateBatchSeconds(pages: number): number {
  const n = Math.max(0, Math.floor(pages));
  if (n === 0) return 0;
  const maxStep = PACE_MAX_EXTRA_MS / PACE_STEP_MS; // steps before the cap
  let totalMs = 0;
  for (let step = 0; step * PACE_STEP_EVERY < n; step++) {
    const extra = Math.min(step * PACE_STEP_MS, PACE_MAX_EXTRA_MS);
    const from = step * PACE_STEP_EVERY;
    const to = Math.min(n, (step + 1) * PACE_STEP_EVERY);
    totalMs += (to - from) * (PACE_BASE_MS + extra + PACE_SPREAD_MS / 2);
    if (step >= maxStep) {
      // Past the cap every remaining page costs the same — close the form.
      const rest = n - to;
      if (rest > 0) {
        totalMs +=
          rest * (PACE_BASE_MS + PACE_MAX_EXTRA_MS + PACE_SPREAD_MS / 2);
      }
      break;
    }
  }
  return Math.round(totalMs / 1000);
}

/** "14 h 37 min" / "42 min" / "unos segundos" — Spanish, for the estimate panel. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return "unos segundos";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours} h` : `${hours} h ${rem} min`;
}

/**
 * "1,4 GB" / "355 MB" / "0 B" — Spanish decimal comma, for the estimate panel.
 *
 * Decimal (1000), not binary (1024), because the units rendered are the SI
 * prefixes kB/MB/GB. Dividing by 1024 while labelling the result "MB" made the
 * panel read 337 MB for the same measurement the issue and the PR prose quote as
 * ~355 MB — a 5% disagreement on the one number the owner is deciding a
 * database-growth question with. Either convention is defensible; disagreeing
 * with itself is not.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const rounded = v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${String(rounded).replace(".", ",")} ${units[i]}`;
}

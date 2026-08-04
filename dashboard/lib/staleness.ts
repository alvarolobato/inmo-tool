/**
 * Listing staleness — the age since a listing was last *re-confirmed live*.
 *
 * Interim signal for the aging-data gap in docs/roadmap/connector-etl-ops.md
 * §6 (issue #243): withdrawal detection is dormant for 7 of 9 connectors
 * (`discovers_full_inventory = False`), so a sold/removed listing may never
 * leave `status = 'active'`. Until real per-listing reconciliation exists,
 * the honest signal we *can* surface is how long it's been since `discover()`
 * last saw the listing in a source's results.
 *
 * ## Which timestamp
 *
 * This module reads `listing.last_seen_at` — "last time a discover() sweep
 * re-confirmed this listing exists" (etl.orchestrator._update_last_seen_for_
 * discovered) — NOT `last_fetched_at`. `last_fetched_at` is gated by the
 * skip-if-seen fetch budget (issue #143 / D-028): a perfectly live, freshly
 * re-confirmed listing is deliberately NOT re-fetched for up to a connector's
 * skip window, so `last_fetched_at` would read "stale" for listings the
 * pipeline is actively confirming. `last_seen_at` is the confirmation signal;
 * `last_fetched_at` is a scraping-budget signal. See init.sql's column
 * comments and D-039.
 *
 * ## Honesty
 *
 * The label is a *fact* ("visto hace N días"), never an inference ("sold").
 * A partial-inventory connector that never re-confirms a given listing will
 * make it look increasingly stale — that is correct and is the whole point
 * (§6.4): we claim less confidence as time passes, never more. Distinct from
 * a `discovers_full_inventory = True` connector's `status = 'withdrawn'`,
 * which is a *confirmed* absence rendered elsewhere (LinkedListings /
 * status-event timeline), not a "we haven't looked recently" guess.
 *
 * Dependency-free by design (no `pg`, no React) so it's usable from both
 * server data modules and client components, and cheap to unit-test — same
 * discipline as lib/listing-status-labels.ts.
 */

export type StalenessBand = "fresh" | "aging" | "stale";

/**
 * Band thresholds, in whole days since `last_seen_at`. Documented and
 * rationalised in docs/decisions/D-039-listing-staleness-surfacing.md.
 *
 * The connector orchestrator sweeps every registered connector roughly
 * hourly (etl.orchestrator.run_scheduler_loop), so a listing a full-inventory
 * connector still carries is re-confirmed many times a day. But
 * partial-inventory connectors (7 of 9) only re-see a listing when it happens
 * to resurface in a page/sitemap slice, so a genuinely-live listing can go
 * days between confirmations without anything being wrong. Day-grained bands
 * (not the 2×-interval = 2h the roadmap floated as an illustration) absorb
 * that normal partial-coverage jitter and only escalate once a gap is long
 * enough to be worth a human's attention:
 *
 *   - `fresh`  (≤ 7 days):  re-confirmed within the last week — unremarkable.
 *   - `aging`  (8–21 days): not seen in a while; worth noticing, not alarming.
 *   - `stale`  (> 21 days): three weeks unconfirmed; may already be gone —
 *                           check the source manually.
 */
export const STALENESS_FRESH_MAX_DAYS = 7;
export const STALENESS_AGING_MAX_DAYS = 21;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface Staleness {
  band: StalenessBand;
  /** Whole days since `last_seen_at`, clamped at 0 (never negative). */
  days: number;
  /** Spanish, human-facing: "visto hoy" | "visto ayer" | "visto hace N días". */
  label: string;
}

export function stalenessBand(days: number): StalenessBand {
  if (days <= STALENESS_FRESH_MAX_DAYS) return "fresh";
  if (days <= STALENESS_AGING_MAX_DAYS) return "aging";
  return "stale";
}

function stalenessLabel(days: number): string {
  if (days <= 0) return "visto hoy";
  if (days === 1) return "visto ayer";
  return `visto hace ${days} días`;
}

/**
 * Computes the staleness of a single `last_seen_at` timestamp.
 *
 * Returns `null` when the timestamp is absent or unparseable — the caller
 * renders *nothing* rather than fabricating a "visto hoy": an unknown
 * last-seen is not the same as a fresh one, and claiming freshness we can't
 * back up is exactly the over-claiming §6 warns against.
 *
 * A future `last_seen_at` (clock skew) clamps to 0 days / `fresh` rather than
 * producing a negative age.
 */
export function computeStaleness(
  lastSeenAt: string | Date | null | undefined,
  now: Date = new Date(),
): Staleness | null {
  if (lastSeenAt == null) return null;
  const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  const seenMs = seen.getTime();
  if (Number.isNaN(seenMs)) return null;
  const days = Math.max(0, Math.floor((now.getTime() - seenMs) / MS_PER_DAY));
  return { band: stalenessBand(days), days, label: stalenessLabel(days) };
}

/**
 * The FRESHEST `last_seen_at` across a property's *active* listings — the
 * "if any linked listing was seen recently, the property isn't stale" rule
 * (issue #243). A deduplicated property carries multiple linked listings
 * (task 2.2); the property is only as stale as its most-recently-confirmed
 * one, so this is a MAX, never a MIN.
 *
 * Active-only, matching how lib/candidates.ts already derives min_price /
 * source badges / the photo union: a withdrawn/sold listing isn't something
 * `discover()` re-confirms, so its (frozen) last_seen_at must not make a
 * property look fresher than its live listings actually are — and, conversely,
 * a property whose only active listing is stale shouldn't be rescued by a
 * withdrawn sibling's old timestamp.
 *
 * Returns `null` when no active listing has a `last_seen_at` (unknown, not
 * fresh — same discipline as `computeStaleness`).
 */
export function freshestActiveLastSeen(
  listings: readonly { status: string; last_seen_at: string | null }[],
): string | null {
  let freshestMs: number | null = null;
  let freshestIso: string | null = null;
  for (const l of listings) {
    if (l.status !== "active") continue;
    if (l.last_seen_at == null) continue;
    const ms = new Date(l.last_seen_at).getTime();
    if (Number.isNaN(ms)) continue;
    if (freshestMs === null || ms > freshestMs) {
      freshestMs = ms;
      freshestIso = l.last_seen_at;
    }
  }
  return freshestIso;
}

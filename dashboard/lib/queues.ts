/**
 * Queue depth + trend — the PURE half (issue #640, part of #636).
 *
 * The owner's question, verbatim: *"quiero saber también colas"* — and, three
 * days later, "what is queued right now and is it growing? is anything
 * stalled?". A single depth number answers only the first half: a queue at
 * 1.700 that is draining is healthy, one at 200 that is growing is not.
 *
 * ## How trend is computed — and why there is no snapshot table
 *
 * Every queue here is a table whose rows carry both an ENTRY timestamp and an
 * EXIT timestamp (`suggested_merge.created_at`/`resolved_at`,
 * `capture_worklist.created_at`+`requeued_at`/`updated_at`,
 * `extension_capture.created_at`/`processed_at`,
 * `etl_manual_trigger.requested_at`/`picked_up_at`). So the flow over the last
 * N hours is a plain `COUNT(*) FILTER (...)` on the queue's own table — no
 * metrics store, no snapshot ledger, no new instrumentation. Direction is then
 * the sign of `inflow − outflow`, which is exactly the identity
 * `depth_now = depth_N_hours_ago + inflow − outflow` read backwards.
 *
 * ## Honesty rules baked into the model
 *
 * `depth`, `inflow24h` and `outflow24h` are each `number | null`, and `null`
 * means **not measured**, never zero. Two queues genuinely can't measure one
 * of them and must say so on the surface rather than render a confident 0:
 *
 *   - the AI-assessment backlog has no entry timestamp at all (a property
 *     enters the backlog when it becomes profile-matched, which nothing
 *     stamps), so `inflow24h` is `null` and the trend degrades to `working`
 *     — "draining, direction unknown" — instead of claiming `draining`;
 *   - the stale-profile queue is *not evaluable at all* while a connector
 *     sweep is running (#285's false-positive flood guard), so its `depth`
 *     is `null` for the duration.
 *
 * This module is client-safe — it imports nothing. The SQL lives in
 * `lib/db/queues.ts`, the surface in `components/estado/QueueBand.tsx`.
 */

/** The window every in/out flow figure on this surface is measured over. */
export const QUEUE_WINDOW_HOURS = 24;

/**
 * Direction of travel, derived by {@link deriveTrend} from depth + flow.
 *
 * `stalled` deliberately outranks `growing`: when work is waiting and NOTHING
 * left the queue in the window, "nothing is being processed" is both true and
 * the more actionable of the two claims.
 */
export type QueueTrend =
  | "unknown" // depth or outflow not measured — no claim made
  | "empty" // nothing queued
  | "stalled" // work waiting, zero outflow over the window
  | "draining" // outflow > inflow
  | "growing" // inflow > outflow
  | "steady" // inflow == outflow, both non-zero
  | "working"; // draining, but inflow is unmeasured — no direction claimed

/** How loudly a tile should read. `alarm` is red, `warn` amber, `ok` neutral. */
export type QueueSeverity = "ok" | "warn" | "alarm";

export interface QueueTile {
  /** Stable id — the e2e/testid handle and the React key. */
  key: string;
  /** Spanish label, short enough for a 150px tile. */
  label: string;
  /** Items waiting right now. `null` when this queue's primary signal is not
   * a count (see `headline`) or is not evaluable (see `unmeasured`). */
  depth: number | null;
  /**
   * Text rendered IN PLACE of the depth number when the queue's primary
   * signal genuinely isn't a count — the dedup PASS tile, whose useful number
   * is "how long since the pass last succeeded", not a backlog size. Never a
   * stand-in for a count we failed to compute; that is `unmeasured`.
   */
  headline: string | null;
  /** Entered the queue in the last {@link QUEUE_WINDOW_HOURS}. `null` = not measured. */
  inflow24h: number | null;
  /** Left the queue in the last {@link QUEUE_WINDOW_HOURS}. `null` = not measured. */
  outflow24h: number | null;
  /** Age of the oldest waiting item, in hours. `null` = nothing waiting / unknown. */
  oldestAgeHours: number | null;
  trend: QueueTrend;
  severity: QueueSeverity;
  /**
   * One short line of context under the numbers — never prose. Used for the
   * dominant portal ("idealista"), the dedup pass's last-success age, or the
   * reason a figure is missing.
   */
  note: string | null;
  /**
   * Why `depth` (or a flow) is `null`, rendered verbatim in place of the
   * number. Present ONLY when something genuinely is not measured — the
   * surface must never show a 0 that is really an absence.
   */
  unmeasured: string | null;
  /** The work surface for this queue. `null` when none exists yet. */
  href: string | null;
  /** Rough drain ETA in hours from depth ÷ outflow rate. `null` when unknowable. */
  etaHours: number | null;
}

/**
 * The one trend derivation, shared by every queue.
 *
 * Edges that matter (all pinned in `lib/__tests__/queues.test.ts`):
 *   - depth 0 → `empty`, regardless of flow (a queue that churned 500 items
 *     and ended at zero is not "draining", it is done).
 *   - depth > 0, outflow 0 → `stalled`, even when inflow is high. See the
 *     type doc for why this outranks `growing`.
 *   - inflow unmeasured (`null`) → `working`, never a direction.
 *   - depth or outflow unmeasured → `unknown`.
 */
export function deriveTrend(
  depth: number | null,
  inflow24h: number | null,
  outflow24h: number | null,
): QueueTrend {
  if (depth === null) return "unknown";
  if (depth <= 0) return "empty";
  if (outflow24h === null) return "unknown";
  if (outflow24h <= 0) return "stalled";
  if (inflow24h === null) return "working";
  if (outflow24h > inflow24h) return "draining";
  if (inflow24h > outflow24h) return "growing";
  return "steady";
}

/** Glyph + Spanish label for a trend, as rendered on the tile. */
export const TREND_LABEL: Record<QueueTrend, string> = {
  unknown: "sin medir",
  empty: "vacía",
  stalled: "sin movimiento",
  draining: "↓ bajando",
  growing: "↑ subiendo",
  steady: "→ estable",
  working: "↓ en curso",
};

/**
 * Rough drain ETA: how long the current depth takes at the observed outflow
 * rate. `null` unless BOTH are measured and outflow is positive — an ETA off a
 * zero rate is infinity, and an ETA off an unmeasured rate is a guess.
 *
 * Deliberately ignores inflow: this is "if nothing else arrived", the number
 * an operator can sanity-check, not a queueing-theory projection.
 */
export function drainEtaHours(
  depth: number | null,
  outflow24h: number | null,
  windowHours: number = QUEUE_WINDOW_HOURS,
): number | null {
  if (depth === null || outflow24h === null) return null;
  if (depth <= 0 || outflow24h <= 0) return null;
  return (depth / outflow24h) * windowHours;
}

/** Compact ETA text, e.g. "~3 h" / "~2 d". */
export function formatEta(etaHours: number | null): string | null {
  if (etaHours === null) return null;
  if (etaHours < 1) return "~<1 h";
  if (etaHours < 48) return `~${Math.round(etaHours)} h`;
  return `~${Math.round(etaHours / 24)} d`;
}

/**
 * Severity ordering for the band: problems first, exactly the ranking the
 * Estado board already applies to its source rows (#638). Ties keep the
 * caller's order, which is the canonical queue order from `lib/db/queues.ts`.
 */
const SEVERITY_RANK: Record<QueueSeverity, number> = { alarm: 0, warn: 1, ok: 2 };

export function sortQueues(tiles: readonly QueueTile[]): QueueTile[] {
  return [...tiles].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Thousands separator, Spanish style ("1.530"). Hand-rolled rather than
 * `toLocaleString("es-ES")` on purpose: CLDR's Spanish rules do NOT group
 * four-digit numbers (`minimumGroupingDigits: 2`), so 1530 would render
 * "1530" here and "1.530" the moment the queue crossed 10.000 — an
 * inconsistency across exactly the range these queues live in. It also makes
 * the output independent of whether the runtime ships full ICU.
 */
export function formatDepth(depth: number | null): string | null {
  if (depth === null) return null;
  const sign = depth < 0 ? "-" : "";
  return sign + String(Math.abs(Math.trunc(depth))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export interface QueuesResponse {
  queues: QueueTile[];
  generatedAt: string;
  /**
   * `false` marks a DEGRADED response after a query failure. An empty
   * `queues` array with `ok: true` would mean "nothing queued anywhere";
   * with `ok: false` it means UNKNOWN. Same posture as
   * `/api/etl/source-health` (issue #638 review).
   */
  ok: boolean;
}

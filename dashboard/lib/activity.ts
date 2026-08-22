/**
 * Actividad — the unified ingest chronology (issue #644, part of #636).
 *
 * This module is the PURE, client-safe half: the event vocabulary, the
 * kind/status labels, the per-kind metric chips and the per-day rollup.
 * `lib/db/activity.ts` holds the SQL that produces the events; nothing here
 * imports a DB driver, so a `"use client"` page can pull it in directly.
 * (Same split as `lib/source-health.ts` / `lib/db/source-health.ts`.)
 *
 * ── Why one vocabulary ───────────────────────────────────────────────────
 * "What happened to my data today?" used to need four surfaces: `/etl` for
 * connector runs, `/etl/salud` for capture aggregates, nothing at all for
 * dedup passes or worklist requeues, and SQL for withdrawals. Every one of
 * those tables records the same abstract fact — *something touched the
 * ingest pipeline at time T, for source S, with these numbers, and it went
 * well or it did not* — so every row here is exactly that shape:
 *
 *     { kind, source, t, tEnd, status, counts, note, detailHref, rolledUp }
 *
 * No per-kind bespoke prose. `error_msg` NEVER renders on the timeline —
 * it is drill-through-only (#531's no-prose rule). The one narrow exception
 * is `codes`, which carries SHORT STABLE CODES, never a free-text error:
 * `connector_run_results.failure_classification` (a closed enum, rendered
 * through `failureClassLabel`) and `.verification_alarm` ("ratio 8/10 >=
 * 80%"), `capture_worklist.requeue_reason`, and a block episode's signature.
 * Each names something no counter on the row can express — a guarded
 * verification run stores `verified_gone_count = 0`, byte-identical to a run
 * where every listing came back alive (see init.sql's note on that column),
 * and a `soft_block` failure is a materially different event from a
 * `structure_change` one even though both read "Error".
 *
 * ── Why a firehose is not a timeline ─────────────────────────────────────
 * Production holds ~4.900 `extension_capture` rows and 2.840 requeued
 * worklist rows. Rendering them one per line is not a chronology, it is a
 * log tail. So the raw rows are rolled up before they ever reach the client:
 * captures into per-portal SESSIONS (30-minute gap, never crossing a
 * Madrid-local midnight), requeues into the batch that wrote them, status
 * changes into per-source runs of the same transition. `rolledUp` on every
 * event says how many raw rows it stands for, so "1.350 capturas" is
 * visibly a rollup and not a claim that one thing happened.
 *
 * ── Why days ─────────────────────────────────────────────────────────────
 * The feed pages by whole Madrid-local days rather than by a row cursor.
 * That is not cosmetic: a session is only well-defined relative to the
 * window it is computed over, and a row cursor mid-session would either
 * split a session across two pages or re-emit it truncated. Day boundaries
 * make paging correct by construction, give the phone UI its section
 * headers, and give each day a rollup line — which is the literal answer to
 * "no sé cuántos datos se ha cargado en las últimas horas".
 *
 * ── Not measured is not zero (D-162) ─────────────────────────────────────
 * Every count here is `number | null`. `null` means the pipeline does not
 * record it and renders "—". It is never coerced to 0, and a 0 denominator
 * renders "—" rather than a division.
 */

// ─── Event vocabulary ────────────────────────────────────────────────────

export type ActivityKind =
  /** One connector's outcome inside a crawl sweep (`connector_run_results`). */
  | "crawl"
  /** A whole sweep that produced NO per-source outcome (`connector_runs`). */
  | "sweep"
  /** A browser-capture session, grouped from `extension_capture`. */
  | "captura"
  /** A re-capture batch, grouped from `capture_worklist.requeued_at` (D-156). */
  | "recola"
  /** One deduplication pass (`dedup_runs`). */
  | "dedup"
  /** An operator-requested sweep (`etl_manual_trigger`). */
  | "manual"
  /** Listing status transitions, grouped (`listing_status_event`, D-157). */
  | "estado"
  /** A capture block/challenge episode (`extension_block_episode`, #637). */
  | "bloqueo";

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  "crawl",
  "sweep",
  "captura",
  "recola",
  "dedup",
  "manual",
  "estado",
  "bloqueo",
];

/**
 * Five states, shared by every kind — the point of one vocabulary.
 *
 * `aviso` is deliberately distinct from `error`: a tripped circuit breaker or
 * a partly-failed capture session is a real thing to look at, but it is not
 * the same claim as "this broke". `omitido` is just as deliberately distinct
 * from both — an operator disabling a connector is a normal state, not an
 * alert (issue #99), and colouring it amber would train the eye to ignore
 * amber.
 */
export type ActivityStatus = "ok" | "aviso" | "error" | "curso" | "omitido";

export interface ActivityEvent {
  /** Stable, unique within a response — used as the React key and testid. */
  id: string;
  kind: ActivityKind;
  /** Connector/portal name, or null for a pipeline-wide event. */
  source: string | null;
  /** ISO start. Sort key; always present. */
  t: string;
  /** ISO end for anything with duration; null when instantaneous. */
  tEnd: string | null;
  status: ActivityStatus;
  /** Numbers only. `null` = not measured (never 0). See D-162. */
  counts: Record<string, number | null>;
  /**
   * The event's SUBTYPE — a machine key, not display text: the transition for
   * `estado`, the trigger for `sweep`/`manual`. Null where a kind has none.
   */
  note: string | null;
  /**
   * Zero or more SHORT STABLE CODES to render as chips. Never `error_msg`
   * (#531). Today: `connector_run_results.failure_classification` and
   * `.verification_alarm`, `capture_worklist.requeue_reason`,
   * `extension_block_episode.signature`.
   */
  codes: string[];
  /** Drill-through, or null when this kind has no deeper surface. */
  detailHref: string | null;
  /** Raw rows this event rolls up. 1 for a singleton. */
  rolledUp: number;
}

export interface ActivityDay {
  /** `YYYY-MM-DD`, Europe/Madrid. */
  day: string;
  events: ActivityEvent[];
}

export interface ActivityResponse {
  days: ActivityDay[];
  /** Inclusive first day of the window returned, `YYYY-MM-DD` Madrid. */
  fromDay: string;
  /** Inclusive last day of the window returned, `YYYY-MM-DD` Madrid. */
  toDay: string;
  /** Day to pass as `before` to load the next (older) page, or null at the
   *  oldest recorded event — never a guess: it is null only when the query
   *  found no event at all before `fromDay`. */
  nextBefore: string | null;
  /** The window hit the server-side row ceiling; older events in it were
   *  dropped. Rendered, never swallowed. */
  truncated: boolean;
  generatedAt: string;
  /**
   * `false` marks a DEGRADED response after a query failure. `days: []` is
   * the shape of BOTH "nothing happened" and "we could not find out", and
   * those are not the same claim — same posture as
   * `SourceHealthResponse.ok` (#638 review).
   */
  ok: boolean;
}

// ─── Labels ──────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<ActivityKind, string> = {
  crawl: "Rastreo",
  sweep: "Pasada",
  captura: "Captura",
  recola: "Recola",
  dedup: "Dedup",
  manual: "Manual",
  estado: "Estado",
  bloqueo: "Bloqueo",
};

/**
 * A single glyph per kind. Deliberately geometric rather than emoji: emoji
 * render at wildly different widths across the platforms this dashboard is
 * read on (macOS Safari vs. Android Chrome), which breaks the fixed-width
 * gutter the rows align on.
 */
export const KIND_GLYPH: Record<ActivityKind, string> = {
  crawl: "↓",
  sweep: "⟳",
  captura: "▣",
  recola: "↺",
  dedup: "⇄",
  manual: "▶",
  estado: "⊘",
  bloqueo: "✕",
};

export const STATUS_LABEL: Record<ActivityStatus, string> = {
  ok: "OK",
  aviso: "Aviso",
  error: "Error",
  curso: "En curso",
  omitido: "Omitido",
};

/**
 * Same four colours the Estado board and Fuentes use for their status dots
 * (`app/admin/page.tsx`, `app/admin/fuentes/[[...name]]/page.tsx`) — one
 * status palette across the admin, never a second definition (#636 verdict).
 * The mapping is fresco→ok, pendiente→aviso, fallando→error, plus a blue for
 * the in-flight state those two surfaces have no equivalent of.
 */
export const STATUS_COLOR: Record<ActivityStatus, string> = {
  ok: "#16a34a",
  aviso: "#d97706",
  error: "#dc2626",
  curso: "#2563eb",
  omitido: "#9a9a9a",
};

/**
 * Spanish labels for `connector_run_results.failure_classification` (D-079,
 * issue #242) — an operator scanning a feed must see "Bloqueo temporal", not
 * "soft_block". Unknown values fall through to the raw string so a future
 * taxonomy value is never swallowed.
 *
 * THE one copy: `components/etl/RunDetail.tsx` imports these rather than
 * keeping its own (it had the only copy before this feed needed them too,
 * and a second copy is how this class of vocabulary silently drifts).
 */
export const FAILURE_CLASS_LABELS: Record<string, string> = {
  soft_block: "Bloqueo temporal",
  network: "Red / conexión",
  structure_change: "Cambio de estructura",
  unresolvable: "Geografía no resoluble",
  uncovered: "Sin cobertura",
  empty_result: "Sin resultados",
  other: "Otro",
};

export function failureClassLabel(kind: string): string {
  return FAILURE_CLASS_LABELS[kind] ?? kind;
}

/**
 * How loudly a typed failure should read. A soft block or an empty result is
 * a clean-run signal, a missing geography is a note, a genuine break is red —
 * the badge must not cry wolf (D-079's own reasoning, preserved verbatim from
 * `RunDetail.tsx`'s `failureClassColor`, which now maps this to its Tremor
 * palette instead of re-deciding it).
 */
export type FailureSeverity = "warn" | "neutral" | "bad";

export function failureClassSeverity(kind: string): FailureSeverity {
  switch (kind) {
    case "soft_block":
    case "empty_result":
      return "warn";
    case "uncovered":
    case "unresolvable":
      return "neutral";
    default:
      return "bad";
  }
}

/** Transition labels for the `estado` kind. */
export const ESTADO_LABEL: Record<string, string> = {
  withdrawn: "Retiradas",
  sold: "Vendidas",
  reserved: "Reservadas",
  expired: "Caducadas",
  reactivated: "Reactivadas",
};

// ─── Formatting ──────────────────────────────────────────────────────────

/** A count, Spanish thousands separators. `null` → "—", never "0". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("es-ES");
}

/** A duration in ms as a short human string. `null` → "—". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/**
 * `total / denom` as a per-unit duration. Returns null (→ "—") when either
 * side is missing or the denominator is 0 — D-162 rule 3: a 0 denominator
 * renders "—", never a division.
 */
export function msPer(total: number | null, denom: number | null): number | null {
  if (total === null || denom === null) return null;
  if (denom <= 0 || total <= 0) return null;
  return total / denom;
}

/** `HH:MM` in Europe/Madrid. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MADRID,
  });
}

/**
 * The `when` column: a single instant (`11:04`) or a session range
 * (`08:20–11:40`). A range is only rendered when the two ends differ at
 * minute resolution — a 40-second "session" reading "11:04–11:04" would
 * imply a duration that is not there.
 */
export function formatWhen(t: string, tEnd: string | null): string {
  const start = formatClock(t);
  if (!tEnd) return start;
  const end = formatClock(tEnd);
  return end === start ? start : `${start}–${end}`;
}

export const MADRID = "Europe/Madrid";

/** `YYYY-MM-DD` (Madrid) for an instant. */
export function madridDay(d: Date): string {
  // `en-CA` renders ISO-ordered Y-M-D, which is exactly the key format we
  // want and avoids hand-assembling parts.
  return d.toLocaleDateString("en-CA", { timeZone: MADRID });
}

/**
 * `YYYY-MM-DD` ± whole days. The arithmetic is done at UTC NOON on purpose:
 * anchoring at midnight and adding 24h lands on 23:00 or 01:00 across a DST
 * boundary, which silently shifts the calendar date by one. Noon has 11
 * hours of slack either way.
 */
export function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** "Hoy" / "Ayer" / "jue, 20 ago" for a `YYYY-MM-DD` day key. */
export function formatDayHeading(day: string, now: Date = new Date()): string {
  const today = madridDay(now);
  if (day === today) return "Hoy";
  const yesterday = madridDay(new Date(now.getTime() - 86_400_000));
  if (day === yesterday) return "Ayer";
  // Parse as UTC noon so the calendar date can't slip a day either way.
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString("es-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: MADRID,
  });
}

// ─── Metric chips ────────────────────────────────────────────────────────

export interface ActivityMetric {
  label: string;
  value: string;
  /** Draw attention: a nonzero error/withdrawal count, an alarm. */
  emphasis?: "bad" | "warn";
}

const c = (ev: ActivityEvent, k: string): number | null => ev.counts[k] ?? null;

/**
 * The 2–4 numbers that matter for one event, in a fixed per-kind order.
 * Kept small on purpose: the row must stay scannable at 390px, and the full
 * picture lives behind `detailHref`.
 */
export function metricsFor(ev: ActivityEvent): ActivityMetric[] {
  switch (ev.kind) {
    case "crawl": {
      const out: ActivityMetric[] = [
        {
          label: "Encontrados → guardados",
          value: `${formatCount(c(ev, "discovered"))} → ${formatCount(c(ev, "fetched"))}`,
        },
      ];
      const unchanged = c(ev, "unchanged");
      if (unchanged) out.push({ label: "Sin cambios", value: formatCount(unchanged) });
      const errors = c(ev, "errors");
      if (errors) out.push({ label: "Errores", value: formatCount(errors), emphasis: "bad" });
      const verified = c(ev, "verified");
      if (verified) {
        out.push({
          label: "Verificados → retirados",
          value: `${formatCount(verified)} → ${formatCount(c(ev, "gone"))}`,
        });
      }
      // D-162: fetch_ms_total already excludes rate-limit sleep at the write
      // site, so dividing by fetched_count is a real per-listing work figure.
      const per = msPer(c(ev, "fetchMsTotal"), c(ev, "fetched"));
      if (per !== null) out.push({ label: "Trabajo/anuncio", value: formatMs(per) });
      return out;
    }
    case "sweep": {
      // The "¿por qué esta pasada no produjo nada?" row. A sweep only gets a
      // row of its own when it recorded no per-connector outcome at all —
      // otherwise its connectors speak for it and this would be a duplicate.
      return [
        { label: "Conectores", value: formatCount(c(ev, "connectors")) },
        { label: "Duración", value: formatMs(c(ev, "durationMs")) },
      ];
    }
    case "captura": {
      const total = c(ev, "total");
      const anomalous = c(ev, "anomalous");
      const out: ActivityMetric[] = [
        { label: "Capturas", value: formatCount(total) },
        { label: "Procesadas", value: formatCount(c(ev, "done")) },
      ];
      if (anomalous) {
        out.push({ label: "Anómalas", value: formatCount(anomalous), emphasis: "warn" });
      }
      const pending = c(ev, "pending");
      if (pending) out.push({ label: "Sin procesar", value: formatCount(pending), emphasis: "warn" });
      // D-162: the render wait is the portal's own cost, kept separate from
      // the ETL's processing_ms and from the ~5 s poll idle between them.
      // `timed` is the number of rows that actually carry it — a portal whose
      // captures predate #695 shows "—", never a fabricated 0.
      const timed = c(ev, "timed");
      if (timed) {
        out.push({ label: "Espera de render (mediana)", value: formatMs(c(ev, "renderWaitMsP50")) });
      }
      return out;
    }
    case "recola":
      return [{ label: "Recoladas", value: formatCount(c(ev, "rows")) }];
    case "dedup": {
      const out: ActivityMetric[] = [
        { label: "Pares comparados", value: formatCount(c(ev, "pairs")) },
        { label: "Fusionados", value: formatCount(c(ev, "merged")) },
        { label: "Sugeridos", value: formatCount(c(ev, "suggested")) },
      ];
      const conflicts = c(ev, "conflicts");
      if (conflicts) out.push({ label: "Conflictos", value: formatCount(conflicts), emphasis: "warn" });
      return out;
    }
    case "manual":
      // D-162 rule 1: this span is `finished_at - requested_at`, which
      // CONTAINS the orchestrator's poll wait before the trigger was picked
      // up. It is not a work measurement and must not be labelled as one.
      return [
        { label: "Solicitud → fin (incluye espera)", value: formatMs(c(ev, "durationMs")) },
      ];
    case "estado": {
      const transition = ev.note ?? "withdrawn";
      const n = c(ev, "rows");
      const withEvidence = c(ev, "withEvidence");
      const out: ActivityMetric[] = [
        {
          label: ESTADO_LABEL[transition] ?? transition,
          value: formatCount(n),
          emphasis: transition === "reactivated" ? undefined : "warn",
        },
      ];
      // D-157: a status change must be able to answer "evidence of what?".
      // Rows written by the older reconciliation paths carry none — say so
      // rather than implying every one of them was verified.
      if (transition !== "reactivated") {
        out.push({ label: "Con evidencia", value: `${formatCount(withEvidence)} / ${formatCount(n)}` });
      }
      return out;
    }
    case "bloqueo":
      return [{ label: "Episodios", value: formatCount(c(ev, "rows")) }];
  }
}

// ─── Per-day rollup ──────────────────────────────────────────────────────

export interface DayRollup {
  /** Listings actually stored: crawl `fetched` + capture `done`. */
  guardados: number;
  /** Raw captures the extension sent, across every session that day. */
  capturas: number;
  /** Listings that changed to a non-active status that day. */
  retiradas: number;
  /** Events in an `error` state, plus per-listing crawl/capture failures. */
  errores: number;
  /** Events still in flight at the moment of the read. */
  enCurso: number;
  /** Timeline rows (after rollup), not raw table rows. */
  eventos: number;
}

/**
 * The one-line answer to "¿cuántos datos se han cargado?" for a day.
 *
 * `guardados` deliberately sums BOTH ingest paths — the run-centric `/etl`
 * monitor could only ever count the crawl half, which is the structural
 * blindness #636 rejected it for.
 */
export function rollupDay(events: readonly ActivityEvent[]): DayRollup {
  const roll: DayRollup = {
    guardados: 0,
    capturas: 0,
    retiradas: 0,
    errores: 0,
    enCurso: 0,
    eventos: events.length,
  };
  for (const ev of events) {
    if (ev.status === "curso") roll.enCurso += 1;
    if (ev.status === "error") roll.errores += 1;
    switch (ev.kind) {
      case "crawl":
        roll.guardados += ev.counts.fetched ?? 0;
        roll.errores += ev.counts.errors ?? 0;
        break;
      case "captura":
        roll.guardados += ev.counts.done ?? 0;
        roll.capturas += ev.counts.total ?? 0;
        roll.errores += ev.counts.failed ?? 0;
        break;
      case "estado":
        if (ev.note !== "reactivated") roll.retiradas += ev.counts.rows ?? 0;
        break;
      default:
        break;
    }
  }
  return roll;
}

// ─── Filtering ───────────────────────────────────────────────────────────

export interface ActivityFilter {
  /** Empty = every kind. */
  kinds: readonly ActivityKind[];
  /** null = every source. */
  source: string | null;
}

export function matchesFilter(ev: ActivityEvent, f: ActivityFilter): boolean {
  if (f.kinds.length > 0 && !f.kinds.includes(ev.kind)) return false;
  if (f.source !== null && ev.source !== f.source) return false;
  return true;
}

/** Every distinct source present in a response, sorted, nulls dropped. */
export function sourcesIn(days: readonly ActivityDay[]): string[] {
  const set = new Set<string>();
  for (const d of days) for (const ev of d.events) if (ev.source) set.add(ev.source);
  return [...set].sort((a, b) => a.localeCompare(b, "es"));
}

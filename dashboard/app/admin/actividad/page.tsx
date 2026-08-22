"use client";

/**
 * Actividad — one chronological ingest ledger (issue #644, part of #636).
 *
 * The surface that answers, in one scroll, the three questions the owner
 * kept having to ask by hand:
 *
 *   - "no sé cuántos datos se ha cargado en las últimas horas"
 *        → the per-day rollup line under each day heading, summing BOTH
 *          ingest paths (crawl + capture), which the run-centric `/etl`
 *          monitor was structurally unable to do.
 *   - "¿se ha atascado algo esta noche?"
 *        → `En curso` rows, `Sin procesar` capture counts, and the error /
 *          aviso chips, all in the same stream and in time order.
 *   - "¿por qué esta pasada no produjo nada?"
 *        → the `Pasada` rows: a sweep that recorded no per-connector outcome
 *          at all, plus the `Omitidos` metric that says WHICH quiet run it
 *          was — `Conectores N · Omitidos N` when every connector is
 *          disabled, `Conectores 0 · Omitidos 0` when none was due (D-050
 *          freshness gate) or none had a scope to cover (#71/#99). No
 *          existing surface could tell those apart. (Production run #212 —
 *          0 conectores, 3 ms — is one of the latter two; it is NOT the
 *          D-009 restart guard, which returns before creating a
 *          `connector_runs` row and so never reaches this timeline.)
 *
 * ── Boundaries with the other two #642 sections ─────────────────────────
 * Estado (#638/#640) is "what is TRUE NOW" — queue depth, freshness, the
 * active-block chip. Fuentes (#676) is "this ONE source in depth" — its
 * config, its worklist, its quality. Actividad is "what HAPPENED, when",
 * across every source at once. So this page deliberately carries no live
 * queue depth, no per-source configuration and no controls: it links out to
 * both of the others instead. The only numbers here are numbers about a
 * moment that has already passed.
 *
 * ── Rendering rules ─────────────────────────────────────────────────────
 * - One vocabulary for every row (see lib/activity.ts). No per-kind prose.
 * - `error_msg` never renders here — drill-through only (#531).
 * - Every count that is not measured renders "—", never 0 (D-162).
 * - Phone-first: every value that differs below 768px lives in a class in
 *   globals.css (`.act-*`), never in an inline style (D-121 rung 1); the
 *   inline styles here carry colour only.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import {
  ACTIVITY_KINDS,
  KIND_GLYPH,
  KIND_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  FAILURE_CLASS_LABELS,
  failureClassLabel,
  failureClassSeverity,
  formatCount,
  formatDayHeading,
  formatWhen,
  matchesFilter,
  metricsFor,
  rollupDay,
  sourcesIn,
} from "@/lib/activity";
import type {
  ActivityEvent,
  ActivityKind,
  ActivityResponse,
} from "@/lib/activity";

/** Days fetched per request, and per "ver más" click. */
const PAGE_DAYS = 3;
/**
 * The narrower window offered when a page comes back truncated. The
 * MAX_EVENTS cap (400, lib/db/activity.ts) applies per REQUEST, not per day,
 * so asking for one day at a time gives each day the whole budget instead of
 * a third of it — which is an actual route to the dropped rows rather than
 * just an apology for them.
 */
const NARROW_DAYS = 1;

export default function ActividadPage() {
  const [pages, setPages] = useState<ActivityResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<ActivityKind[]>([]);
  const [source, setSource] = useState<string | null>(null);
  /** Switched on from the truncation banner; never back off automatically. */
  const [narrow, setNarrow] = useState(false);

  const fetchPage = useCallback(
    async (before: string | null, days: number): Promise<ActivityResponse | null> => {
    const qs = new URLSearchParams({ days: String(days) });
    if (before) qs.set("before", before);
    const res = await fetch(`/api/etl/activity?${qs.toString()}`);
    if (!res.ok) throw new Error("No se pudo cargar la actividad.");
    return (await res.json()) as ActivityResponse;
    },
    [],
  );

  const pageDays = narrow ? NARROW_DAYS : PAGE_DAYS;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const first = await fetchPage(null, pageDays);
        if (!cancelled && first) setPages([first]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Error al cargar la actividad.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage, pageDays]);

  const last = pages[pages.length - 1];
  const nextBefore = last?.nextBefore ?? null;
  // A degraded read (`ok: false`) must never be rendered as "no hay
  // actividad" — that asserts a fact about a state we do not know.
  const degraded = pages.length > 0 && pages.some((p) => !p.ok);

  const loadMore = useCallback(async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchPage(nextBefore, pageDays);
      if (page) setPages((prev) => [...prev, page]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar más actividad.");
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, nextBefore, pageDays]);

  const allDays = useMemo(() => pages.flatMap((p) => p.days), [pages]);
  const sources = useMemo(() => sourcesIn(allDays), [allDays]);
  const truncated = pages.some((p) => p.truncated);

  const filter = useMemo(() => ({ kinds, source }), [kinds, source]);

  /** Counts per kind BEFORE the kind filter (so a chip never reads 0 just
   *  because it is currently deselected), but AFTER the source filter. */
  const kindCounts = useMemo(() => {
    const counts = new Map<ActivityKind, number>();
    for (const d of allDays) {
      for (const ev of d.events) {
        if (source !== null && ev.source !== source) continue;
        counts.set(ev.kind, (counts.get(ev.kind) ?? 0) + 1);
      }
    }
    return counts;
  }, [allDays, source]);

  const visibleDays = useMemo(
    () =>
      allDays
        .map((d) => ({ day: d.day, events: d.events.filter((ev) => matchesFilter(ev, filter)) }))
        .filter((d) => d.events.length > 0),
    [allDays, filter],
  );

  const toggleKind = (k: ActivityKind) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <main className="route-shell act-page" data-testid="actividad-page">
      <header className="act-header">
        <h1 className="act-title">Actividad</h1>
        <p className="act-sub">
          Qué ha pasado en la ingesta y cuándo.{" "}
          <Link href="/admin" className="act-inline-link">
            Estado
          </Link>{" "}
          dice qué es cierto ahora;{" "}
          <Link href="/admin/fuentes" className="act-inline-link">
            Fuentes
          </Link>
          , una fuente en detalle.
        </p>
      </header>

      {error && <ErrorDisplay error={error} />}

      {degraded && (
        <p className="act-degraded" data-testid="actividad-degraded">
          No se ha podido leer la actividad. Lo que falta aquí no significa que no haya pasado nada.
        </p>
      )}

      {/* ── Filters ─────────────────────────────────────────────────── */}
      <div className="act-filters" data-testid="actividad-filters">
        <div className="act-chips" role="group" aria-label="Filtrar por tipo">
          <button
            type="button"
            className="act-chip"
            aria-pressed={kinds.length === 0}
            data-testid="kind-chip-todo"
            onClick={() => setKinds([])}
          >
            Todo
          </button>
          {ACTIVITY_KINDS.filter((k) => (kindCounts.get(k) ?? 0) > 0).map((k) => (
            <button
              key={k}
              type="button"
              className="act-chip"
              aria-pressed={kinds.includes(k)}
              data-testid={`kind-chip-${k}`}
              onClick={() => toggleKind(k)}
            >
              <span aria-hidden="true">{KIND_GLYPH[k]}</span>
              {KIND_LABEL[k]}
              <span className="act-chip-count">{kindCounts.get(k)}</span>
            </button>
          ))}
        </div>
        <label className="act-source-filter">
          <span className="act-source-label">Fuente</span>
          <select
            className="act-select"
            data-testid="source-filter"
            value={source ?? ""}
            onChange={(e) => setSource(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">Todas</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* The cap is per REQUEST, so a narrower window is a real route to the
          dropped rows, not a consolation. Only offered while it would
          actually change something: once already at one day per request,
          the honest message is that the cap is hit and there is no further
          narrowing left. */}
      {truncated && (
        <p className="act-degraded" data-testid="actividad-truncated">
          Se ha alcanzado el límite de eventos de la ventana: faltan los más antiguos de estos
          días.{" "}
          {narrow ? (
            <>
              Ya se está cargando un día por petición, que es la ventana más estrecha disponible:
              este día por sí solo supera el límite.
            </>
          ) : (
            <>
              <button
                type="button"
                className="act-narrow-btn"
                data-testid="actividad-narrow"
                onClick={() => setNarrow(true)}
              >
                Cargar un día por petición
              </button>{" "}
              para recuperarlos.
            </>
          )}
        </p>
      )}

      {loading ? (
        <p className="act-empty" data-testid="actividad-loading">
          Cargando actividad…
        </p>
      ) : visibleDays.length === 0 ? (
        <p className="act-empty" data-testid="actividad-empty">
          {degraded
            ? "Sin datos que mostrar."
            : "No hay actividad de ingesta en este periodo con estos filtros."}
        </p>
      ) : (
        visibleDays.map((d) => <DaySection key={d.day} day={d.day} events={d.events} />)
      )}

      <div className="act-more">
        {nextBefore ? (
          <button
            type="button"
            className="act-more-btn"
            data-testid="actividad-load-more"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Cargando…" : "Ver días anteriores"}
          </button>
        ) : (
          !loading && (
            <p className="act-empty" data-testid="actividad-exhausted">
              No hay actividad registrada antes de este periodo.
            </p>
          )
        )}
      </div>
    </main>
  );
}

// ─── Day section ───────────────────────────────────────────────────────────

function DaySection({ day, events }: { day: string; events: ActivityEvent[] }) {
  const roll = rollupDay(events);
  // Only the parts that actually happened. A rollup line reading
  // "0 capturas · 0 retiradas" on a crawl-only day is noise pretending to be
  // information.
  const parts: string[] = [];
  if (roll.guardados) parts.push(`${formatCount(roll.guardados)} anuncios guardados`);
  if (roll.capturas) parts.push(`${formatCount(roll.capturas)} capturas`);
  if (roll.retiradas) parts.push(`${formatCount(roll.retiradas)} retiradas`);
  // Two units, never summed into one figure: `errores` counts ANUNCIOS that
  // failed, `eventosConError` counts whole runs/sessions that failed. Adding
  // them yielded a "30 errores" that was neither 30 listings nor 30 runs.
  if (roll.errores)
    parts.push(`${formatCount(roll.errores)} ${roll.errores === 1 ? "anuncio" : "anuncios"} con error`);
  if (roll.eventosConError)
    parts.push(
      `${formatCount(roll.eventosConError)} ${roll.eventosConError === 1 ? "evento" : "eventos"} con error`,
    );
  if (roll.enCurso) parts.push(`${formatCount(roll.enCurso)} en curso`);

  return (
    <section className="act-day" data-testid={`actividad-day-${day}`}>
      <h2 className="act-day-title">{formatDayHeading(day)}</h2>
      <p className="act-day-roll" data-testid={`actividad-rollup-${day}`}>
        {parts.length > 0
          ? parts.join(" · ")
          : `${formatCount(roll.eventos)} ${roll.eventos === 1 ? "evento" : "eventos"}`}
      </p>
      <ol className="act-list">
        {events.map((ev) => (
          <li key={ev.id}>
            <ActivityRow event={ev} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A typed failure's severity, in the same palette as the status chips. */
const CODE_COLOR: Record<"warn" | "neutral" | "bad", string> = {
  warn: STATUS_COLOR.aviso,
  neutral: STATUS_COLOR.omitido,
  bad: STATUS_COLOR.error,
};

/**
 * What colour a code chip gets.
 *
 * Only a member of the closed `failure_classification` enum is coloured by
 * D-079's severity ranking. Everything else is muted, and that distinction
 * matters: a `crawl` row's other code is the mass-withdrawal guard's verdict
 * (an action WITHHELD — amber, look at it), while a `recola` row's code is
 * the operator's own requeue reason and a `bloqueo` row's is a WAF signature.
 * Colouring those three the same red would make an ordinary re-capture batch
 * read like a breakage — the exact "cry wolf" failure D-079 warns about.
 */
function codeColor(kind: string, code: string): string {
  if (code in FAILURE_CLASS_LABELS) return CODE_COLOR[failureClassSeverity(code)];
  if (kind === "crawl") return STATUS_COLOR.aviso;
  return "var(--fg-subtle)";
}

// ─── One row ───────────────────────────────────────────────────────────────

function ActivityRow({ event }: { event: ActivityEvent }) {
  const metrics = metricsFor(event);
  const body = (
    <>
      <span className="act-glyph" aria-hidden="true" style={{ color: STATUS_COLOR[event.status] }}>
        {KIND_GLYPH[event.kind]}
      </span>
      <span className="act-main">
        <span className="act-head">
          <span className="act-source">{event.source ?? "Todos los conectores"}</span>
          <span className="act-kind">{KIND_LABEL[event.kind]}</span>
          {event.status !== "ok" && (
            <span
              className="act-status"
              data-testid={`act-status-${event.id}`}
              style={{ color: STATUS_COLOR[event.status], borderColor: STATUS_COLOR[event.status] }}
            >
              {STATUS_LABEL[event.status]}
            </span>
          )}
          {event.rolledUp > 1 && (
            <span className="act-rollup" title="Filas agrupadas en este evento">
              ×{formatCount(event.rolledUp)}
            </span>
          )}
        </span>
        <span className="act-metrics">
          {metrics.map((m) => (
            <span key={m.label} className="act-metric" title={m.note}>
              <span className="act-metric-label">
                {m.label}
                {m.note && (
                  <abbr className="act-metric-caveat" title={m.note} aria-label={m.note}>
                    *
                  </abbr>
                )}
              </span>
              <span
                className="act-metric-value"
                style={m.emphasis ? { color: STATUS_COLOR[m.emphasis === "bad" ? "error" : "aviso"] } : undefined}
              >
                {m.value}
              </span>
            </span>
          ))}
        </span>
        {/* SHORT STABLE CODES only — never `error_msg` (#531). See
            lib/activity.ts's header for the columns allowed here. A typed
            failure kind renders through its Spanish label and its own
            severity colour; anything else renders verbatim, so a taxonomy
            value we do not know yet is shown rather than swallowed. */}
        {event.codes.length > 0 && (
          <span className="act-codes">
            {/* Keyed by position, not by value: `codes` is not guaranteed to
                hold distinct short codes. `verification_alarm` (#643) is free
                text — init.sql's own examples are 'ratio 8/10 >= 80%' and
                'baseline 60% vs 0% histórico' — so two rolled-up rows can
                carry the identical string and a value key would collide. The
                array is render-only and never reordered, so the index is
                stable here. */}
            {event.codes.map((code, i) => (
              <span
                key={`${i}-${code}`}
                className="act-code"
                title={code}
                style={{ color: codeColor(event.kind, code) }}
              >
                {failureClassLabel(code)}
              </span>
            ))}
          </span>
        )}
      </span>
      <time className="act-when" dateTime={event.t}>
        {formatWhen(event.t, event.tEnd)}
      </time>
    </>
  );

  if (event.detailHref) {
    return (
      <Link href={event.detailHref} className="act-row act-row-link" data-testid={`act-row-${event.id}`}>
        {body}
      </Link>
    );
  }
  return (
    <span className="act-row" data-testid={`act-row-${event.id}`}>
      {body}
    </span>
  );
}

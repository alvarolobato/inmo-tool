/**
 * GET /api/home[?date=YYYY-MM-DD]
 *
 * Returns the HomeViewModel rendered by /inicio. All values come from
 * real PostgreSQL aggregation against the ps_* mirror tables; nothing
 * is fabricated.
 *
 * Scope: retail-only. Wholesale is intentionally excluded — `/inicio` is
 * the retail business overview.
 *
 * As-of date semantics:
 * - If `?date=YYYY-MM-DD` is supplied and falls within the available
 *   mirror range, that date is used as the as-of pivot.
 * - Otherwise we fall back to MAX(fecha_creacion) FROM ps_ventas, which
 *   is "the last business day with recorded retail sales".
 *
 * Limitations:
 * - ps_ventas has only date granularity (no time-of-day), so the hero's
 *   `hourly` / `hourlyComparison` arrays are returned empty. HeroToday
 *   detects this and renders a daily-resolution layout instead.
 * - The "store name" comes from the new `ps_tiendas.identificador` field
 *   (4D `Tiendas.IdentificadorTienda`). When empty, we fall back to
 *   `poblacion`, then to "Tienda {codigo}".
 */

import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import type { HomeViewModel, Metric } from "@/lib/home-types";

export const dynamic = "force-dynamic";

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];
const DAYS_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeRatio(num_: number, den: number): number {
  if (!den) return 0;
  return num_ / den - 1;
}

function fmtAsOf(d: Date): string {
  // Render in Europe/Madrid regardless of host TZ.
  const fmt = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday").replace(".", "");
  const dd = get("day");
  const mon = get("month").replace(".", "");
  const hh = get("hour");
  const mm = get("minute");
  return `${wd} ${dd} ${mon} · ${hh}:${mm}`;
}

function fmtSyncAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 6) / 10;
  if (h < 48) return `${h} h`;
  const d = Math.round(h / 24);
  return `${d} d`;
}

function statusFromDelta(delta: number, streakWeeks = 0): "ok" | "watch" | "alert" {
  if (delta <= -0.10 || streakWeeks >= 5) return "alert";
  if (delta <= -0.04 || streakWeeks >= 3) return "watch";
  return "ok";
}

function trendDirectionFromSpark(spark: number[]): "up" | "flat" | "down" {
  if (spark.length < 2) return "flat";
  // Linear regression slope: positive = up, negative = down
  const n = spark.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += spark[i];
    sumXY += i * spark[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (!denom) return "flat";
  const slope = (n * sumXY - sumX * sumY) / denom;
  const meanY = sumY / n;
  if (!meanY) return "flat";
  const relSlope = slope / meanY;
  if (relSlope > 0.02) return "up";
  if (relSlope < -0.02) return "down";
  return "flat";
}

/** YoY-aware semaphore: uses deltaYoY as the primary signal when available,
 *  falls back to the 7-day delta when YoY is null. A sustained weekly
 *  streak (per-store consecutive weeks below YoY) is additive — it can
 *  only raise severity, never lower it. */
function statusFromDeltas(
  delta7d: number,
  deltaYoY: number | null,
  streakWeeks = 0,
): "ok" | "watch" | "alert" {
  let base: "ok" | "watch" | "alert";
  if (deltaYoY !== null) {
    if (deltaYoY <= -0.15) base = "alert";
    else if (deltaYoY <= -0.05) base = "watch";
    else base = "ok";
  } else {
    base = statusFromDelta(delta7d);
  }
  const streakStatus: "ok" | "watch" | "alert" =
    streakWeeks >= 5 ? "alert" : streakWeeks >= 3 ? "watch" : "ok";
  const rank = { ok: 0, watch: 1, alert: 2 } as const;
  return rank[streakStatus] > rank[base] ? streakStatus : base;
}

function dateLabelEs(d: Date): string {
  return `${DAYS_ES[d.getDay()]} ${d.getDate()} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}`;
}

function isoWeekOf(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/** Choose a display label for a store: identificador → poblacion → "Tienda {codigo}". */
function storeName(identificador: unknown, poblacion: unknown, codigo: string): string {
  const id = (identificador ?? "").toString().trim();
  if (id) return id;
  const pob = (poblacion ?? "").toString().trim();
  if (pob) return pob;
  return `Tienda ${codigo}`;
}

export async function GET(req: NextRequest) {
  try {
    // ─────────────────────────────────────────────────────────────────────
    // Resolve as-of date: ?date=YYYY-MM-DD wins (if valid + in range),
    // otherwise the most recent day with retail sales in the mirror.
    // ─────────────────────────────────────────────────────────────────────
    const requested = req.nextUrl.searchParams.get("date");
    const requestedClean =
      requested && ISO_DATE_RE.test(requested) ? requested : null;

    const pivotRow = await query(
      `SELECT
         (SELECT MAX(fecha_creacion) FROM ps_ventas
           WHERE entrada=true AND tienda<>'99')::text AS max_synced,
         (SELECT MIN(fecha_creacion) FROM ps_ventas
           WHERE entrada=true AND tienda<>'99')::text AS min_synced,
         (NOW() AT TIME ZONE 'Europe/Madrid')::date::text AS today_madrid,
         NOW() AS now_utc,
         -- Latest hour observed in today's mirror, in Madrid local hour. Used
         -- to clamp the cutoff to what we actually have data for, rather
         -- than the wall-clock — otherwise a mid-day request with stale ETL
         -- compares "today=0 (no rows yet)" vs "yesterday up to hour 14"
         -- and the deltas turn even more deeply red than before.
         (SELECT EXTRACT(HOUR FROM MAX(hora_creacion))::int FROM ps_ventas
           WHERE entrada=true AND tienda<>'99'
             AND hora_creacion IS NOT NULL
             AND fecha_creacion = (NOW() AT TIME ZONE 'Europe/Madrid')::date) AS today_mirror_hour,
         (SELECT COUNT(*)::int FROM ps_ventas
           WHERE entrada=true AND tienda<>'99'
             AND fecha_creacion = (NOW() AT TIME ZONE 'Europe/Madrid')::date) AS today_row_count`,
    );
    const maxSyncedStr = String(pivotRow.rows[0][0] ?? "");
    const minAvailStr = String(pivotRow.rows[0][1] ?? "");
    const todayMadrid = String(pivotRow.rows[0][2] ?? "");
    const nowUtcIso = String(pivotRow.rows[0][3] ?? "");
    const todayMirrorHour =
      pivotRow.rows[0][4] !== null && pivotRow.rows[0][4] !== undefined
        ? Number(pivotRow.rows[0][4])
        : null;
    const todayRowCount = Number(pivotRow.rows[0][5] ?? 0);

    // Default as-of (when no ?date= supplied):
    //   - if today (Madrid) has any mirrored rows → today_madrid, so the
    //     same-hour-cutoff path fires and the user lands on a live view;
    //   - otherwise → max_synced (yesterday under nightly ETL), so KPIs
    //     are computed against a closed day instead of an empty today.
    // The navigator cap (`maxAvailableDate`) still goes up to today_madrid
    // so the user can scroll forward and back regardless of the default.
    let asOfDate =
      todayMadrid && todayRowCount > 0 ? todayMadrid : (maxSyncedStr || todayMadrid);
    if (requestedClean) {
      if (minAvailStr && requestedClean < minAvailStr) asOfDate = minAvailStr;
      else if (todayMadrid && requestedClean > todayMadrid) asOfDate = todayMadrid;
      else asOfDate = requestedClean;
    }
    const maxAvailableDate = todayMadrid || maxSyncedStr || asOfDate;

    const [y, m, d] = asOfDate.split("-").map((s) => parseInt(s, 10));
    const asOfDateObj = new Date(y, m - 1, d);
    const lastYearSameDay = new Date(y - 1, m - 1, d);

    // ─────────────────────────────────────────────────────────────────────
    // Same-hour-cutoff comparison
    //
    // When the as-of date IS today, today's value is a *running total* up
    // to the current Madrid hour. Comparing it against yesterday's or last
    // year's *full-day* total guarantees a deep red until the closing
    // hour, so most of the trading day the deltas are useless.
    //
    // Fix: when as-of is today, compare today-running vs yesterday-and-LY
    // *up to the same hour*. For past as-of dates we keep the full-day
    // comparison — both sides are closed, so apples-to-apples is full-vs-full.
    //
    // The cutoff hour is `LEAST(currentHourMadrid, todayMirrorHour)`. If
    // the ETL hasn't synced today's recent hours yet, today's running
    // total only covers up to `todayMirrorHour`, so we clamp the cutoff
    // there to keep the comparison fair. If today has zero rows in the
    // mirror at all, we deactivate the cutoff (the cutoff branch would
    // compare 0 today vs 0 yesterday, which is meaningless).
    // ─────────────────────────────────────────────────────────────────────
    const isAsOfToday = asOfDate === todayMadrid;
    const madridHourFmt = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      hour12: false,
    });
    const currentHourMadrid = parseInt(madridHourFmt.format(new Date(nowUtcIso)), 10);
    const effectiveCutoffHour =
      todayMirrorHour !== null
        ? Math.min(currentHourMadrid, todayMirrorHour)
        : currentHourMadrid;
    const cutoffActive = isAsOfToday && todayRowCount > 0;
    // Placeholder when cutoff is inactive — never read because the SQL
    // gate (`NOT $3::bool OR …`) short-circuits before evaluating it.
    const cutoffHour = cutoffActive ? effectiveCutoffHour : 0;

    // asOf header: most recent successful sales-domain sync (for staleness).
    const watermarkRow = await query(
      `SELECT
         MAX(last_sync_at) FILTER (WHERE status = 'ok') AS max_ok,
         MAX(last_sync_at)                              AS max_any
       FROM etl_watermarks
       WHERE table_name IN ('ventas','lineas_ventas')`,
    );
    const maxSyncOk = watermarkRow.rows[0][0] as string | null;
    const maxSyncAny = watermarkRow.rows[0][1] as string | null;
    const asOfHeader = fmtAsOf(
      new Date(maxSyncOk ?? maxSyncAny ?? nowUtcIso),
    );

    // ─────────────────────────────────────────────────────────────────────
    // Run aggregations in parallel.
    // ─────────────────────────────────────────────────────────────────────
    const [
      heroRow,
      hourlyTodayRow,
      hourlyComparisonRow,
      periodHoyRow,
      periodSemanaRow,
      periodMesRow,
      periodAnyoRow,
      hoySpark7Row,
      semanaSpark6Row,
      mesSpark5Row,
      anyoSpark5Row,
      businessStreakRow,
      storeStreakRow,
      dailyTrendRow,
      storesRow,
      storesSparkRow,
      opsRetailRow,
      retailMonthRow,
      opsRetailPrevDayRow,
      retailPrevMonthRow,
      baseline30dRow,
      etlRunRow,
      anomaliesRow,
      lastWatermarkRow,
      marginHoyRow,
      marginSemanaRow,
      marginMesRow,
      marginAnyoRow,
      marginHoySpark7Row,
      marginSemanaSpark6Row,
      marginMesSpark5Row,
      marginAnyoSpark5Row,
      storesMarginRow,
    ] = await Promise.all([
      // Hero today / yesterday / LY same day. Returns BOTH a full-day SUM
      // and a same-hour-cutoff SUM for yesterday and LY. The route picks
      // which one drives the delta based on `cutoffActive`. `$2` is the
      // cutoff hour (0..23); when the cutoff is inactive ($3=false) every
      // row qualifies, so the cutoff column equals the full column.
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN fecha_creacion = $1::date           THEN total_si END), 0) AS hoy,
           COALESCE(SUM(CASE WHEN fecha_creacion = ($1::date - INTERVAL '1 day')::date THEN total_si END), 0) AS ayer_full,
           COALESCE(SUM(CASE WHEN fecha_creacion = ($1::date - INTERVAL '1 day')::date
                              AND (NOT $3::bool
                                   OR (hora_creacion IS NOT NULL
                                       AND EXTRACT(HOUR FROM hora_creacion) <= $2::int))
                            THEN total_si END), 0) AS ayer_cutoff,
           COALESCE(SUM(CASE WHEN fecha_creacion = ($1::date - INTERVAL '1 year')::date THEN total_si END), 0) AS ly_full,
           COALESCE(SUM(CASE WHEN fecha_creacion = ($1::date - INTERVAL '1 year')::date
                              AND (NOT $3::bool
                                   OR (hora_creacion IS NOT NULL
                                       AND EXTRACT(HOUR FROM hora_creacion) <= $2::int))
                            THEN total_si END), 0) AS ly_cutoff
         FROM ps_ventas
         WHERE entrada = true AND tienda <> '99'
           AND fecha_creacion BETWEEN ($1::date - INTERVAL '1 year' - INTERVAL '7 days')::date AND $1::date`,
        [asOfDate, cutoffHour, cutoffActive],
      ),

      // Hero hourly (cumulative through hour) for the as-of day. NULL
      // values for hours that have no rows AND no preceding rows. Once
      // ps_ventas.hora_creacion is fully backfilled, this drives the
      // intraday curve in HeroToday. When hora_creacion is NULL on every
      // row (pre-backfill), the cumulative is 0 across all hours and the
      // route falls back to empty arrays so the hero shows the
      // "Sin granularidad horaria" panel.
      query(
        `WITH hours AS (
           SELECT generate_series(0, 23) AS h
         ),
         per_hour AS (
           SELECT EXTRACT(HOUR FROM hora_creacion)::int AS h,
                  SUM(total_si)::numeric AS s
           FROM ps_ventas
           WHERE entrada = true AND tienda <> '99'
             AND fecha_creacion = $1::date
             AND hora_creacion IS NOT NULL
           GROUP BY EXTRACT(HOUR FROM hora_creacion)
         )
         SELECT h.h,
                COALESCE(SUM(p.s) OVER (ORDER BY h.h), 0)::numeric AS cumul,
                EXISTS (SELECT 1 FROM per_hour) AS has_data
         FROM hours h LEFT JOIN per_hour p ON p.h = h.h
         ORDER BY h.h`,
        [asOfDate],
      ),

      // Hero hourly cumulative for the **same weekday one week before**
      // the as-of day. Weekday-aligned comparison: as-of Saturday →
      // previous Saturday, not yesterday (which would be Friday). The UI
      // legend label is derived from `asOfDate - 7 days` so it stays
      // honest about which day is being compared.
      query(
        `WITH hours AS (
           SELECT generate_series(0, 23) AS h
         ),
         per_hour AS (
           SELECT EXTRACT(HOUR FROM hora_creacion)::int AS h,
                  SUM(total_si)::numeric AS s
           FROM ps_ventas
           WHERE entrada = true AND tienda <> '99'
             AND fecha_creacion = ($1::date - INTERVAL '7 days')::date
             AND hora_creacion IS NOT NULL
           GROUP BY EXTRACT(HOUR FROM hora_creacion)
         )
         SELECT h.h,
                COALESCE(SUM(p.s) OVER (ORDER BY h.h), 0)::numeric AS cumul,
                EXISTS (SELECT 1 FROM per_hour) AS has_data
         FROM hours h LEFT JOIN per_hour p ON p.h = h.h
         ORDER BY h.h`,
        [asOfDate],
      ),

      // Period: hoy — same cutoff treatment as the hero query so the Hoy
      // card's "vs ayer" / "vs LY" deltas don't go all-red while the day
      // is still in progress.
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN fecha_creacion = $1::date           THEN total_si END), 0) AS hoy,
           COALESCE(SUM(CASE WHEN fecha_creacion = ($1::date - INTERVAL '1 day')::date
                              AND (NOT $3::bool
                                   OR (hora_creacion IS NOT NULL
                                       AND EXTRACT(HOUR FROM hora_creacion) <= $2::int))
                            THEN total_si END), 0) AS ayer,
           COALESCE(SUM(CASE WHEN fecha_creacion = ($1::date - INTERVAL '1 year')::date
                              AND (NOT $3::bool
                                   OR (hora_creacion IS NOT NULL
                                       AND EXTRACT(HOUR FROM hora_creacion) <= $2::int))
                            THEN total_si END), 0) AS lyear
         FROM ps_ventas
         WHERE entrada = true AND tienda <> '99'
           AND fecha_creacion BETWEEN ($1::date - INTERVAL '1 year' - INTERVAL '2 days')::date AND $1::date`,
        [asOfDate, cutoffHour, cutoffActive],
      ),

      // Period: semana
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('week', $1::date)::date
                              AND fecha_creacion <= $1::date THEN total_si END), 0) AS curr,
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('week', ($1::date - INTERVAL '1 week'))::date
                              AND fecha_creacion <  DATE_TRUNC('week', $1::date)::date THEN total_si END), 0) AS prev,
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('week', ($1::date - INTERVAL '1 year'))::date
                              AND fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN total_si END), 0) AS lyear
         FROM ps_ventas
         WHERE entrada = true AND tienda <> '99'
           AND fecha_creacion >= ($1::date - INTERVAL '1 year' - INTERVAL '2 weeks')::date
           AND fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Period: mes
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('month', $1::date)::date
                              AND fecha_creacion <= $1::date THEN total_si END), 0) AS curr,
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('month', $1::date - INTERVAL '1 month')::date
                              AND fecha_creacion <  DATE_TRUNC('month', $1::date)::date THEN total_si END), 0) AS prev,
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('month', $1::date - INTERVAL '1 year')::date
                              AND fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN total_si END), 0) AS lyear
         FROM ps_ventas
         WHERE entrada = true AND tienda <> '99'
           AND fecha_creacion >= ($1::date - INTERVAL '1 year' - INTERVAL '2 months')::date
           AND fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Period: año YTD
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('year', $1::date)::date
                              AND fecha_creacion <= $1::date THEN total_si END), 0) AS curr,
           COALESCE(SUM(CASE WHEN fecha_creacion >= DATE_TRUNC('year', $1::date - INTERVAL '1 year')::date
                              AND fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN total_si END), 0) AS lyear
         FROM ps_ventas
         WHERE entrada = true AND tienda <> '99'
           AND fecha_creacion >= ($1::date - INTERVAL '2 years')::date
           AND fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Hoy spark: last 7 days
      query(
        `SELECT day::date AS day, COALESCE(SUM(v.total_si), 0)::numeric AS value
         FROM generate_series(($1::date - INTERVAL '6 days')::date, $1::date, '1 day') day
         LEFT JOIN ps_ventas v
           ON v.fecha_creacion = day::date
          AND v.entrada = true AND v.tienda <> '99'
         GROUP BY day ORDER BY day`,
        [asOfDate],
      ),

      // Semana spark: 6 ISO weeks ending this week
      query(
        `WITH weeks AS (
           SELECT week_start FROM generate_series(
             DATE_TRUNC('week', $1::date - INTERVAL '5 weeks')::date,
             DATE_TRUNC('week', $1::date)::date,
             '1 week'
           ) week_start
         )
         SELECT w.week_start::date AS week_start,
                EXTRACT(WEEK FROM w.week_start)::int AS iso_week,
                COALESCE(SUM(v.total_si), 0)::numeric AS value
         FROM weeks w
         LEFT JOIN ps_ventas v
           ON v.fecha_creacion >= w.week_start
          AND v.fecha_creacion <  (w.week_start + INTERVAL '1 week')::date
          AND v.entrada = true AND v.tienda <> '99'
         GROUP BY w.week_start ORDER BY w.week_start`,
        [asOfDate],
      ),

      // Mes spark: last 5 months
      query(
        `WITH months AS (
           SELECT month_start FROM generate_series(
             DATE_TRUNC('month', $1::date - INTERVAL '4 months')::date,
             DATE_TRUNC('month', $1::date)::date,
             '1 month'
           ) month_start
         )
         SELECT m.month_start::date AS month_start,
                EXTRACT(MONTH FROM m.month_start)::int AS mon,
                COALESCE(SUM(v.total_si), 0)::numeric AS value
         FROM months m
         LEFT JOIN ps_ventas v
           ON v.fecha_creacion >= m.month_start
          AND v.fecha_creacion <  (m.month_start + INTERVAL '1 month')::date
          AND v.entrada = true AND v.tienda <> '99'
         GROUP BY m.month_start ORDER BY m.month_start`,
        [asOfDate],
      ),

      // Año spark: cumulative YTD by month for current year
      query(
        `WITH months AS (
           SELECT month_start FROM generate_series(
             DATE_TRUNC('year', $1::date)::date,
             DATE_TRUNC('month', $1::date)::date,
             '1 month'
           ) month_start
         )
         SELECT m.month_start::date AS month_start,
                EXTRACT(MONTH FROM m.month_start)::int AS mon,
                COALESCE(SUM(v.total_si), 0)::numeric AS value
         FROM months m
         LEFT JOIN ps_ventas v
           ON v.fecha_creacion >= m.month_start
          AND v.fecha_creacion <  (m.month_start + INTERVAL '1 month')::date
          AND v.entrada = true AND v.tienda <> '99'
         GROUP BY m.month_start ORDER BY m.month_start`,
        [asOfDate],
      ),

      // Business-level weekly streak: consecutive complete ISO weeks below YoY.
      // Returns one row per ISO week for the last 16 complete ISO weeks.
      // A "complete" week ends before the ISO week that contains asOfDate,
      // so partial weeks don't generate false positives.
      // The streak is computed by the application (not SQL) from the ordered rows.
      // LY is matched by the same ISO week number in the prior ISO year
      // (avoids the ±7-day drift that occurs at year boundaries with -1 year).
      query(
        `WITH weeks AS (
           SELECT
             week_start,
             (DATE_TRUNC('week', MAKE_DATE(EXTRACT(ISOYEAR FROM week_start)::int - 1, 1, 4)) +
              INTERVAL '1 day' * ((EXTRACT(WEEK FROM week_start)::int - 1) * 7))::date AS ly_week_start
           FROM generate_series(
             DATE_TRUNC('week', $1::date - INTERVAL '16 weeks')::date,
             DATE_TRUNC('week', $1::date - INTERVAL '1 week')::date,
             '1 week'
           ) week_start
         ),
         sales_agg AS (
           SELECT
             DATE_TRUNC('week', fecha_creacion)::date AS sale_week,
             SUM(total_si) AS weekly_total
           FROM ps_ventas
           WHERE entrada = true AND tienda <> '99'
             AND fecha_creacion >= (DATE_TRUNC('week', $1::date - INTERVAL '16 weeks') - INTERVAL '1 year')::date
             AND fecha_creacion <  DATE_TRUNC('week', $1::date)::date
           GROUP BY DATE_TRUNC('week', fecha_creacion)::date
         )
         SELECT
           w.week_start::date AS week_start,
           COALESCE(cy.weekly_total, 0)::numeric AS curr_sales,
           COALESCE(ly.weekly_total, 0)::numeric AS ly_sales
         FROM weeks w
         LEFT JOIN sales_agg cy ON cy.sale_week = w.week_start
         LEFT JOIN sales_agg ly ON ly.sale_week = w.ly_week_start
         ORDER BY w.week_start DESC`,
        [asOfDate],
      ),

      // Per-store weekly streak: same consecutive-weeks-below-YoY metric per store.
      // Returns one row per (store, week) for the last 16 complete ISO weeks.
      // LY is matched by the same ISO week number in the prior ISO year.
      query(
        `WITH weeks AS (
           SELECT
             week_start,
             (DATE_TRUNC('week', MAKE_DATE(EXTRACT(ISOYEAR FROM week_start)::int - 1, 1, 4)) +
              INTERVAL '1 day' * ((EXTRACT(WEEK FROM week_start)::int - 1) * 7))::date AS ly_week_start
           FROM generate_series(
             DATE_TRUNC('week', $1::date - INTERVAL '16 weeks')::date,
             DATE_TRUNC('week', $1::date - INTERVAL '1 week')::date,
             '1 week'
           ) week_start
         ),
         stores AS (
           SELECT DISTINCT tienda FROM ps_ventas
           WHERE entrada = true AND tienda <> '99'
             AND fecha_creacion >= ($1::date - INTERVAL '30 days')::date
         ),
         sales_agg AS (
           SELECT
             tienda,
             DATE_TRUNC('week', fecha_creacion)::date AS sale_week,
             SUM(total_si) AS weekly_total
           FROM ps_ventas
           WHERE entrada = true AND tienda <> '99'
             AND fecha_creacion >= (DATE_TRUNC('week', $1::date - INTERVAL '16 weeks') - INTERVAL '1 year')::date
             AND fecha_creacion <  DATE_TRUNC('week', $1::date)::date
           GROUP BY tienda, DATE_TRUNC('week', fecha_creacion)::date
         )
         SELECT
           s.tienda,
           w.week_start::date AS week_start,
           COALESCE(cy.weekly_total, 0)::numeric AS curr_sales,
           COALESCE(ly.weekly_total, 0)::numeric AS ly_sales
         FROM stores s
         CROSS JOIN weeks w
         LEFT JOIN sales_agg cy ON cy.tienda = s.tienda AND cy.sale_week = w.week_start
         LEFT JOIN sales_agg ly ON ly.tienda = s.tienda AND ly.sale_week = w.ly_week_start
         ORDER BY s.tienda, w.week_start DESC`,
        [asOfDate],
      ),

      // Daily trend: current month + same days LY
      query(
        `WITH days AS (
           SELECT generate_series(
             DATE_TRUNC('month', $1::date)::date,
             (DATE_TRUNC('month', $1::date) + INTERVAL '1 month' - INTERVAL '1 day')::date,
             '1 day'
           )::date AS day
         )
         SELECT EXTRACT(DAY FROM d.day)::int AS day_num,
                COALESCE((SELECT SUM(v.total_si) FROM ps_ventas v
                          WHERE v.entrada=true AND v.tienda<>'99'
                            AND v.fecha_creacion = d.day), 0)::numeric AS actual,
                COALESCE((SELECT SUM(v.total_si) FROM ps_ventas v
                          WHERE v.entrada=true AND v.tienda<>'99'
                            AND v.fecha_creacion = (d.day - INTERVAL '1 year')::date), 0)::numeric AS ly,
                d.day > $1::date AS is_future
         FROM days d
         ORDER BY d.day`,
        [asOfDate],
      ),

      // ALL stores for the as-of date (sorted by sales DESC), plus a
      // 30-day total used to flag the store as inactive. Stores with
      // total_30d = 0 don't appear in the main table — they live in the
      // separate "tiendas inactivas" list. LEFT JOIN keeps stores that
      // are open today but had a slow as-of day.
      // Column order: codigo[0], identificador[1], poblacion[2], sales[3],
      // avg7[4], total_30d[5], last_sale_date[6], sales_ly[7],
      // returns_rate[8], tickets[9].
      query(
        `SELECT t.codigo,
                t.identificador,
                t.poblacion,
                COALESCE(s.sales, 0)::numeric AS sales,
                COALESCE(avg7.avg7, 0)::numeric AS avg7,
                COALESCE(s30.total_30d, 0)::numeric AS total_30d,
                last_sale.last_sale_date::text AS last_sale_date,
                ly.sales_ly::numeric AS sales_ly,
                store_ret.returns_rate,
                COALESCE(s.tickets, 0)::int AS tickets
         FROM ps_tiendas t
         LEFT JOIN (
           SELECT tienda, SUM(total_si) AS sales, COUNT(DISTINCT reg_ventas)::int AS tickets
           FROM ps_ventas
           WHERE entrada=true AND tienda<>'99' AND fecha_creacion = $1::date
           GROUP BY tienda
         ) s ON s.tienda = t.codigo
         LEFT JOIN (
           SELECT tienda, AVG(daily_total)::numeric AS avg7
           FROM (
             SELECT tienda, fecha_creacion, SUM(total_si) AS daily_total
             FROM ps_ventas
             WHERE entrada=true AND tienda<>'99'
               AND fecha_creacion >= ($1::date - INTERVAL '7 days')::date
               AND fecha_creacion <  $1::date
             GROUP BY tienda, fecha_creacion
           ) per_day
           GROUP BY tienda
         ) avg7 ON avg7.tienda = t.codigo
         LEFT JOIN (
           SELECT tienda, SUM(total_si) AS total_30d
           FROM ps_ventas
           WHERE entrada=true AND tienda<>'99'
             AND fecha_creacion >= ($1::date - INTERVAL '30 days')::date
             AND fecha_creacion <= $1::date
           GROUP BY tienda
         ) s30 ON s30.tienda = t.codigo
         LEFT JOIN (
           -- Last sale across all history. Drives the "ver tiendas
           -- inactivas" caption, not the 30-day filter. Measured at
           -- ~240 ms on the 911 K-row mirror with the existing
           -- idx_ventas_tienda — runs in parallel with the other 18
           -- aggregates on the route, so it doesn't bottleneck.
           -- (Avoid stray semicolons inside SQL: the read-only guard
           -- in lib/db.ts rejects them as multi-statement.)
           SELECT tienda, MAX(fecha_creacion) AS last_sale_date
           FROM ps_ventas
           WHERE entrada=true AND tienda<>'99'
           GROUP BY tienda
         ) last_sale ON last_sale.tienda = t.codigo
         LEFT JOIN (
           SELECT tienda, SUM(total_si) AS sales_ly
           FROM ps_ventas
           WHERE entrada=true AND tienda<>'99'
             AND fecha_creacion = ($1::date - INTERVAL '1 year')::date
           GROUP BY tienda
         ) ly ON ly.tienda = t.codigo
         LEFT JOIN (
           SELECT tienda,
                  COALESCE(SUM(CASE WHEN entrada=false THEN ABS(total_si) END), 0)::numeric
                    / NULLIF(COALESCE(SUM(CASE WHEN entrada=true THEN total_si END), 0), 0) AS returns_rate
           FROM ps_ventas
           WHERE fecha_creacion = $1::date AND tienda <> '99'
           GROUP BY tienda
         ) store_ret ON store_ret.tienda = t.codigo
         WHERE t.codigo <> '99'
         ORDER BY COALESCE(s.sales, 0) DESC, t.codigo`,
        [asOfDate],
      ),

      // 7-day spark per store (all stores, last 7 days)
      query(
        `WITH days AS (
           SELECT generate_series(($1::date - INTERVAL '6 days')::date, $1::date, '1 day')::date AS day
         )
         SELECT t.codigo, d.day,
                COALESCE((SELECT SUM(v.total_si) FROM ps_ventas v
                          WHERE v.entrada=true
                            AND v.tienda = t.codigo
                            AND v.fecha_creacion = d.day), 0)::numeric AS sales
         FROM ps_tiendas t CROSS JOIN days d
         WHERE t.codigo <> '99'
         ORDER BY t.codigo, d.day`,
        [asOfDate],
      ),

      // Retail ops: tickets, gross, devoluciones for as-of date
      query(
        `SELECT
           COUNT(DISTINCT CASE WHEN entrada=true THEN reg_ventas END)::int AS tickets,
           COALESCE(SUM(CASE WHEN entrada=true THEN total_si END), 0)::numeric AS gross,
           COALESCE(SUM(CASE WHEN entrada=false THEN ABS(total_si) END), 0)::numeric AS devolu
         FROM ps_ventas
         WHERE tienda<>'99' AND fecha_creacion = $1::date`,
        [asOfDate],
      ),

      // Retail ops: month margin
      query(
        `SELECT
           COALESCE(SUM(lv.total_si), 0)::numeric AS rev,
           COALESCE(SUM(lv.total_coste_si), 0)::numeric AS cost
         FROM ps_lineas_ventas lv
         JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
         WHERE v.entrada=true AND lv.tienda<>'99' AND lv.total_si > 0
           AND lv.fecha_creacion >= DATE_TRUNC('month', $1::date)::date
           AND lv.fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Retail ops prev-day: tickets, gross, devoluciones — same-hour cutoff support
      query(
        `SELECT
           COUNT(DISTINCT CASE WHEN entrada=true THEN reg_ventas END)::int AS tickets_prev,
           COALESCE(SUM(CASE WHEN entrada=true THEN total_si END), 0)::numeric AS gross_prev,
           COALESCE(SUM(CASE WHEN entrada=false THEN ABS(total_si) END), 0)::numeric AS devolu_prev
         FROM ps_ventas
         WHERE tienda<>'99'
           AND fecha_creacion = ($1::date - INTERVAL '1 day')::date
           AND (NOT $3::bool
                OR (hora_creacion IS NOT NULL
                    AND EXTRACT(HOUR FROM hora_creacion) <= $2::int))`,
        [asOfDate, cutoffHour, cutoffActive],
      ),

      // Retail ops prev-month margin: previous full calendar month rev + cost
      query(
        `SELECT
           COALESCE(SUM(lv.total_si), 0)::numeric AS rev,
           COALESCE(SUM(lv.total_coste_si), 0)::numeric AS cost
         FROM ps_lineas_ventas lv
         JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
         WHERE v.entrada=true AND lv.tienda<>'99' AND lv.total_si > 0
           AND lv.fecha_creacion >= DATE_TRUNC('month', $1::date - INTERVAL '1 month')::date
           AND lv.fecha_creacion < DATE_TRUNC('month', $1::date)::date`,
        [asOfDate],
      ),

      // 30-day rolling return rate baseline (returns / gross sales).
      // Result is a fraction (0..1) stored in rows[0][0]; null when no
      // gross sales in the period (avoids div-by-zero via NULLIF).
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN entrada=false THEN ABS(total_si) END), 0)::numeric
             / NULLIF(COALESCE(SUM(CASE WHEN entrada=true THEN total_si END), 0), 0) AS rate_30d
         FROM ps_ventas
         WHERE tienda<>'99'
           AND fecha_creacion >= ($1::date - INTERVAL '29 days')::date
           AND fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // ETL latest run
      query(
        `SELECT id, status, started_at, finished_at, total_rows_synced
         FROM etl_sync_runs
         ORDER BY id DESC LIMIT 1`,
      ),

      // ETL anomalies
      query(
        `SELECT COUNT(*)::int AS n FROM etl_watermarks WHERE status <> 'ok'`,
      ),

      // ETL most recent watermark
      query(
        `SELECT MAX(last_sync_at) AS last FROM etl_watermarks`,
      ),

      // Margin period: hoy
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN lv.fecha_creacion = $1::date
                            THEN lv.total_si END), 0)::numeric AS rev_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion = $1::date
                            THEN lv.total_coste_si END), 0)::numeric AS cost_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion = ($1::date - INTERVAL '1 day')::date
                            THEN lv.total_si END), 0)::numeric AS rev_prev,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion = ($1::date - INTERVAL '1 day')::date
                            THEN lv.total_coste_si END), 0)::numeric AS cost_prev,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion = ($1::date - INTERVAL '1 year')::date
                            THEN lv.total_si END), 0)::numeric AS rev_ly,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion = ($1::date - INTERVAL '1 year')::date
                            THEN lv.total_coste_si END), 0)::numeric AS cost_ly
         FROM ps_lineas_ventas lv
         JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
         WHERE v.entrada=true AND lv.tienda<>'99' AND lv.total_si > 0
           AND lv.fecha_creacion >= ($1::date - INTERVAL '1 year' - INTERVAL '2 days')::date
           AND lv.fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Margin period: semana
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('week', $1::date)::date
                              AND lv.fecha_creacion <= $1::date THEN lv.total_si END), 0)::numeric AS rev_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('week', $1::date)::date
                              AND lv.fecha_creacion <= $1::date THEN lv.total_coste_si END), 0)::numeric AS cost_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('week', ($1::date - INTERVAL '1 week'))::date
                              AND lv.fecha_creacion <  DATE_TRUNC('week', $1::date)::date THEN lv.total_si END), 0)::numeric AS rev_prev,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('week', ($1::date - INTERVAL '1 week'))::date
                              AND lv.fecha_creacion <  DATE_TRUNC('week', $1::date)::date THEN lv.total_coste_si END), 0)::numeric AS cost_prev,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('week', ($1::date - INTERVAL '1 year'))::date
                              AND lv.fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN lv.total_si END), 0)::numeric AS rev_ly,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('week', ($1::date - INTERVAL '1 year'))::date
                              AND lv.fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN lv.total_coste_si END), 0)::numeric AS cost_ly
         FROM ps_lineas_ventas lv
         JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
         WHERE v.entrada=true AND lv.tienda<>'99' AND lv.total_si > 0
           AND lv.fecha_creacion >= ($1::date - INTERVAL '1 year' - INTERVAL '2 weeks')::date
           AND lv.fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Margin period: mes
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('month', $1::date)::date
                              AND lv.fecha_creacion <= $1::date THEN lv.total_si END), 0)::numeric AS rev_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('month', $1::date)::date
                              AND lv.fecha_creacion <= $1::date THEN lv.total_coste_si END), 0)::numeric AS cost_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('month', $1::date - INTERVAL '1 month')::date
                              AND lv.fecha_creacion <  DATE_TRUNC('month', $1::date)::date THEN lv.total_si END), 0)::numeric AS rev_prev,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('month', $1::date - INTERVAL '1 month')::date
                              AND lv.fecha_creacion <  DATE_TRUNC('month', $1::date)::date THEN lv.total_coste_si END), 0)::numeric AS cost_prev,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('month', $1::date - INTERVAL '1 year')::date
                              AND lv.fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN lv.total_si END), 0)::numeric AS rev_ly,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('month', $1::date - INTERVAL '1 year')::date
                              AND lv.fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN lv.total_coste_si END), 0)::numeric AS cost_ly
         FROM ps_lineas_ventas lv
         JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
         WHERE v.entrada=true AND lv.tienda<>'99' AND lv.total_si > 0
           AND lv.fecha_creacion >= ($1::date - INTERVAL '1 year' - INTERVAL '2 months')::date
           AND lv.fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Margin period: año YTD
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('year', $1::date)::date
                              AND lv.fecha_creacion <= $1::date THEN lv.total_si END), 0)::numeric AS rev_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('year', $1::date)::date
                              AND lv.fecha_creacion <= $1::date THEN lv.total_coste_si END), 0)::numeric AS cost_curr,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('year', $1::date - INTERVAL '1 year')::date
                              AND lv.fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN lv.total_si END), 0)::numeric AS rev_ly,
           COALESCE(SUM(CASE WHEN lv.fecha_creacion >= DATE_TRUNC('year', $1::date - INTERVAL '1 year')::date
                              AND lv.fecha_creacion <= ($1::date - INTERVAL '1 year')::date THEN lv.total_coste_si END), 0)::numeric AS cost_ly
         FROM ps_lineas_ventas lv
         JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
         WHERE v.entrada=true AND lv.tienda<>'99' AND lv.total_si > 0
           AND lv.fecha_creacion >= ($1::date - INTERVAL '2 years')::date
           AND lv.fecha_creacion <= $1::date`,
        [asOfDate],
      ),

      // Margin hoy spark: last 7 days daily margin
      query(
        `SELECT day::date AS day,
                COALESCE(SUM(lv.total_si), 0)::numeric AS rev,
                COALESCE(SUM(lv.total_coste_si), 0)::numeric AS cost
         FROM generate_series(($1::date - INTERVAL '6 days')::date, $1::date, '1 day') day
         LEFT JOIN (
           SELECT lv.fecha_creacion, lv.total_si, lv.total_coste_si
           FROM ps_lineas_ventas lv
           JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas AND v.entrada = true
           WHERE lv.tienda <> '99' AND lv.total_si > 0
         ) lv ON lv.fecha_creacion = day::date
         GROUP BY day ORDER BY day`,
        [asOfDate],
      ),

      // Margin semana spark: 6 ISO weeks ending this week
      query(
        `WITH weeks AS (
           SELECT week_start FROM generate_series(
             DATE_TRUNC('week', $1::date - INTERVAL '5 weeks')::date,
             DATE_TRUNC('week', $1::date)::date,
             '1 week'
           ) week_start
         )
         SELECT w.week_start::date AS week_start,
                EXTRACT(WEEK FROM w.week_start)::int AS iso_week,
                COALESCE(SUM(lv.total_si), 0)::numeric AS rev,
                COALESCE(SUM(lv.total_coste_si), 0)::numeric AS cost
         FROM weeks w
         LEFT JOIN (
           SELECT lv.fecha_creacion, lv.total_si, lv.total_coste_si
           FROM ps_lineas_ventas lv
           JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas AND v.entrada = true
           WHERE lv.tienda <> '99' AND lv.total_si > 0
         ) lv ON lv.fecha_creacion >= w.week_start
              AND lv.fecha_creacion <  (w.week_start + INTERVAL '1 week')::date
         GROUP BY w.week_start ORDER BY w.week_start`,
        [asOfDate],
      ),

      // Margin mes spark: last 5 months
      query(
        `WITH months AS (
           SELECT month_start FROM generate_series(
             DATE_TRUNC('month', $1::date - INTERVAL '4 months')::date,
             DATE_TRUNC('month', $1::date)::date,
             '1 month'
           ) month_start
         )
         SELECT m.month_start::date AS month_start,
                EXTRACT(MONTH FROM m.month_start)::int AS mon,
                COALESCE(SUM(lv.total_si), 0)::numeric AS rev,
                COALESCE(SUM(lv.total_coste_si), 0)::numeric AS cost
         FROM months m
         LEFT JOIN (
           SELECT lv.fecha_creacion, lv.total_si, lv.total_coste_si
           FROM ps_lineas_ventas lv
           JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas AND v.entrada = true
           WHERE lv.tienda <> '99' AND lv.total_si > 0
         ) lv ON lv.fecha_creacion >= m.month_start
              AND lv.fecha_creacion <  (m.month_start + INTERVAL '1 month')::date
         GROUP BY m.month_start ORDER BY m.month_start`,
        [asOfDate],
      ),

      // Margin año spark: YTD by month current year
      query(
        `WITH months AS (
           SELECT month_start FROM generate_series(
             DATE_TRUNC('year', $1::date)::date,
             DATE_TRUNC('month', $1::date)::date,
             '1 month'
           ) month_start
         )
         SELECT m.month_start::date AS month_start,
                EXTRACT(MONTH FROM m.month_start)::int AS mon,
                COALESCE(SUM(lv.total_si), 0)::numeric AS rev,
                COALESCE(SUM(lv.total_coste_si), 0)::numeric AS cost
         FROM months m
         LEFT JOIN (
           SELECT lv.fecha_creacion, lv.total_si, lv.total_coste_si
           FROM ps_lineas_ventas lv
           JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas AND v.entrada = true
           WHERE lv.tienda <> '99' AND lv.total_si > 0
         ) lv ON lv.fecha_creacion >= m.month_start
              AND lv.fecha_creacion <  (m.month_start + INTERVAL '1 month')::date
         GROUP BY m.month_start ORDER BY m.month_start`,
        [asOfDate],
      ),

      // Per-store margin for the as-of date
      query(
        `SELECT lv.tienda,
                COALESCE(SUM(lv.total_si), 0)::numeric AS rev,
                COALESCE(SUM(lv.total_coste_si), 0)::numeric AS cost
         FROM ps_lineas_ventas lv
         JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
         WHERE v.entrada=true AND lv.tienda<>'99' AND lv.total_si > 0
           AND lv.fecha_creacion = $1::date
         GROUP BY lv.tienda`,
        [asOfDate],
      ),
    ]);

    // ─────────────────────────────────────────────────────────────────────
    // Hero
    // ─────────────────────────────────────────────────────────────────────
    const todayValue = num(heroRow.rows[0][0]);
    const yesterdayFull = num(heroRow.rows[0][1]);
    const yesterdayCutoffRaw = num(heroRow.rows[0][2]);
    const lastYearFull = num(heroRow.rows[0][3]);
    const lastYearCutoffRaw = num(heroRow.rows[0][4]);
    // Legacy-NULL fallback: if the cutoff branch returns 0 because the
    // comparison day has only pre-backfill rows (`hora_creacion IS NULL`
    // is excluded by the cutoff predicate), the comparison is misleading
    // — today vs 0 always reads "+∞%". Fall back to the full-day value
    // for that side when the cutoff is empty but the full-day total
    // exists.
    const yesterdayCutoff =
      cutoffActive && yesterdayCutoffRaw === 0 && yesterdayFull > 0
        ? yesterdayFull
        : yesterdayCutoffRaw;
    const lastYearCutoff =
      cutoffActive && lastYearCutoffRaw === 0 && lastYearFull > 0
        ? lastYearFull
        : lastYearCutoffRaw;
    // Pick which side drives the delta. When today is closed (asOfDate is
    // in the past), the cutoff columns equal the full columns, so this
    // is a no-op — the picks just keep the code honest.
    const yesterdayForDelta = cutoffActive ? yesterdayCutoff : yesterdayFull;
    const lastYearForDelta = cutoffActive ? lastYearCutoff : lastYearFull;

    // Build hourly cumulative arrays from the per-hour query. When the
    // mirror has no time-of-day data for either day (rows where
    // hora_creacion IS NULL), we return empty arrays so HeroToday falls
    // back to its "Sin granularidad horaria" pane.
    const todayHasHourly = hourlyTodayRow.rows.length > 0
      && (hourlyTodayRow.rows[0][2] === true || hourlyTodayRow.rows[0][2] === "t");
    const comparisonHasHourly = hourlyComparisonRow.rows.length > 0
      && (hourlyComparisonRow.rows[0][2] === true || hourlyComparisonRow.rows[0][2] === "t");

    // For the as-of day mask hours after the current hour as `null` when
    // the as-of date IS today_madrid (the day is still in progress).
    // For past days, every hour is in the past, so no masking.
    const hourlyToday: (number | null)[] = todayHasHourly
      ? hourlyTodayRow.rows.map((r) => {
          const h = num(r[0]);
          const cumul = num(r[1]);
          if (isAsOfToday && h > currentHourMadrid) return null;
          return cumul;
        })
      : [];

    const hourlyComparisonArr: number[] = comparisonHasHourly
      ? hourlyComparisonRow.rows.map((r) => num(r[1]))
      : [];

    // Build the comparison legend label from the as-of date minus 7 days
    // (same weekday). e.g. "Sábado anterior" — keeps the UI honest
    // about which day is plotted, instead of the previous hardcoded
    // "Mismo lunes 2025" string.
    const compDate = new Date(y, m - 1, d - 7);
    const COMP_DAYS_ES = [
      "Domingo", "Lunes", "Martes", "Miércoles",
      "Jueves", "Viernes", "Sábado",
    ];
    const comparisonLabel = `${COMP_DAYS_ES[compDate.getDay()]} anterior`;

    const hero: HomeViewModel["hero"] = {
      todayValue,
      forecastEOD: todayValue,
      todayPace: 0,
      vsYesterday: safeRatio(todayValue, yesterdayForDelta),
      vsLY: safeRatio(todayValue, lastYearForDelta),
      yesterday: yesterdayFull,
      lastYear: lastYearFull,
      // When the cutoff is active, expose the hour and the cutoff totals
      // so the UI can show "hasta las HH:00 · X €" alongside the delta.
      comparisonCutoffHour: cutoffActive ? cutoffHour : null,
      yesterdayCutoff: cutoffActive ? yesterdayCutoff : null,
      lastYearCutoff: cutoffActive ? lastYearCutoff : null,
      status: "on-pace",
      hourly: hourlyToday,
      hourlyComparison: hourlyComparisonArr,
      comparisonLabel,
    };

    // ─────────────────────────────────────────────────────────────────────
    // Periods
    // ─────────────────────────────────────────────────────────────────────
    const periodHoyCurr = num(periodHoyRow.rows[0][0]);
    const periodHoyPrev = num(periodHoyRow.rows[0][1]);
    const periodHoyLY = num(periodHoyRow.rows[0][2]);
    const semCurr = num(periodSemanaRow.rows[0][0]);
    const semPrev = num(periodSemanaRow.rows[0][1]);
    const semLY = num(periodSemanaRow.rows[0][2]);
    const mesCurr = num(periodMesRow.rows[0][0]);
    const mesPrev = num(periodMesRow.rows[0][1]);
    const mesLY = num(periodMesRow.rows[0][2]);
    const anyoCurr = num(periodAnyoRow.rows[0][0]);
    const anyoLY = num(periodAnyoRow.rows[0][1]);

    const hoySpark = hoySpark7Row.rows.map((r) => num(r[1]));
    const hoySparkLabels = hoySpark7Row.rows.map((r) => {
      const [yy, mm, dd] = String(r[0]).split("-").map((s) => parseInt(s, 10));
      return DAYS_ES[new Date(yy, mm - 1, dd).getDay()];
    });
    const semSpark = semanaSpark6Row.rows.map((r) => num(r[2]));
    const semSparkLabels = semanaSpark6Row.rows.map((r) => `s${num(r[1])}`);
    const mesSpark = mesSpark5Row.rows.map((r) => num(r[2]));
    const mesSparkLabels = mesSpark5Row.rows.map((r) => MONTHS_ES[num(r[1]) - 1] || "");
    const anyoSpark = anyoSpark5Row.rows.map((r) => num(r[2]));
    const anyoSparkLabels = anyoSpark5Row.rows.map((r) => MONTHS_ES[num(r[1]) - 1] || "");

    // Compute business-level streak: rows are ordered DESC by week_start
    // (most recent complete week first). Count consecutive weeks where
    // curr_sales < ly_sales, stopping at the first non-declining week.
    let businessStreakWeeks = 0;
    for (const r of businessStreakRow.rows) {
      const curr = num(r[1]);
      const ly = num(r[2]);
      if (ly > 0 && curr < ly) {
        businessStreakWeeks++;
      } else {
        break;
      }
    }

    // Compute per-store streak: group storeStreakRow by tienda, then count
    // consecutive declining weeks (rows already ordered DESC by week_start
    // within each tienda group).
    const storeStreakMap: Record<string, number> = {};
    const storeWeeksSeen: Record<string, boolean> = {};
    for (const r of storeStreakRow.rows) {
      const tienda = String(r[0]);
      const curr = num(r[2]);
      const ly = num(r[3]);
      // Once a non-declining week is seen for a store, stop counting for it.
      if (storeWeeksSeen[tienda]) continue;
      if (!(tienda in storeStreakMap)) storeStreakMap[tienda] = 0;
      if (ly > 0 && curr < ly) {
        storeStreakMap[tienda]++;
      } else {
        storeWeeksSeen[tienda] = true;
      }
    }

    const periods: HomeViewModel["periods"] = [
      {
        id: "hoy",
        label: "Hoy",
        value: periodHoyCurr,
        deltaPrev: safeRatio(periodHoyCurr, periodHoyPrev),
        prevLabel: cutoffActive
          ? `vs ayer (hasta las ${String(cutoffHour).padStart(2, "0")}:00)`
          : "vs ayer",
        deltaYoY: periodHoyLY > 0 ? safeRatio(periodHoyCurr, periodHoyLY) : null,
        yoyLabel: cutoffActive
          ? `vs ${dateLabelEs(lastYearSameDay)} (hasta las ${String(cutoffHour).padStart(2, "0")}:00)`
          : `vs ${dateLabelEs(lastYearSameDay)}`,
        spark: hoySpark,
        sparkLabels: hoySparkLabels,
        trendDirection: trendDirectionFromSpark(hoySpark),
      },
      {
        id: "semana",
        label: "Semana",
        value: semCurr,
        deltaPrev: safeRatio(semCurr, semPrev),
        prevLabel: "vs sem ant",
        deltaYoY: semLY > 0 ? safeRatio(semCurr, semLY) : null,
        yoyLabel: `vs sem ${isoWeekOf(asOfDateObj)} ${asOfDateObj.getFullYear() - 1}`,
        spark: semSpark,
        sparkLabels: semSparkLabels,
        streakWeeks: businessStreakWeeks,
        trendDirection: trendDirectionFromSpark(semSpark),
      },
      {
        id: "mes",
        label: "Mes",
        value: mesCurr,
        deltaPrev: safeRatio(mesCurr, mesPrev),
        prevLabel: "vs mes ant",
        deltaYoY: mesLY > 0 ? safeRatio(mesCurr, mesLY) : null,
        yoyLabel: `vs ${MONTHS_ES[asOfDateObj.getMonth()]} ${asOfDateObj.getFullYear() - 1}`,
        spark: mesSpark,
        sparkLabels: mesSparkLabels,
        trendDirection: trendDirectionFromSpark(mesSpark),
      },
      {
        id: "anyo",
        // For YTD the natural "previous" comparison IS year-over-year
        // (there is no distinct previous-period concept), so deltaPrev
        // and deltaYoY share the same value.
        label: "Año (YTD)",
        value: anyoCurr,
        deltaPrev: anyoLY > 0 ? safeRatio(anyoCurr, anyoLY) : 0,
        prevLabel: `vs YTD ${asOfDateObj.getFullYear() - 1}`,
        deltaYoY: anyoLY > 0 ? safeRatio(anyoCurr, anyoLY) : null,
        yoyLabel: `vs ${asOfDateObj.getFullYear() - 1} mismo tramo`,
        spark: anyoSpark,
        sparkLabels: anyoSparkLabels,
        trendDirection: trendDirectionFromSpark(anyoSpark),
      },
    ];

    // ─────────────────────────────────────────────────────────────────────
    // Margin periods
    // ─────────────────────────────────────────────────────────────────────
    function marginFrac(rev: number, cost: number): number | null {
      return rev > 0 ? (rev - cost) / rev : null;
    }

    // Hoy margin (use same date logic as ventas hoy — no cutoff for margin
    // since we lack hora_creacion on lineas_ventas)
    const mHoyCurrRev = num(marginHoyRow.rows[0][0]);
    const mHoyCurrCost = num(marginHoyRow.rows[0][1]);
    const mHoyPrevRev = num(marginHoyRow.rows[0][2]);
    const mHoyPrevCost = num(marginHoyRow.rows[0][3]);
    const mHoyLYRev = num(marginHoyRow.rows[0][4]);
    const mHoyLYCost = num(marginHoyRow.rows[0][5]);
    const mHoyCurr = marginFrac(mHoyCurrRev, mHoyCurrCost);
    const mHoyPrev = marginFrac(mHoyPrevRev, mHoyPrevCost);
    const mHoyLY = marginFrac(mHoyLYRev, mHoyLYCost);

    // Semana margin
    const mSemCurrRev = num(marginSemanaRow.rows[0][0]);
    const mSemCurrCost = num(marginSemanaRow.rows[0][1]);
    const mSemPrevRev = num(marginSemanaRow.rows[0][2]);
    const mSemPrevCost = num(marginSemanaRow.rows[0][3]);
    const mSemLYRev = num(marginSemanaRow.rows[0][4]);
    const mSemLYCost = num(marginSemanaRow.rows[0][5]);
    const mSemCurr = marginFrac(mSemCurrRev, mSemCurrCost);
    const mSemPrev = marginFrac(mSemPrevRev, mSemPrevCost);
    const mSemLY = marginFrac(mSemLYRev, mSemLYCost);

    // Mes margin
    const mMesCurrRev = num(marginMesRow.rows[0][0]);
    const mMesCurrCost = num(marginMesRow.rows[0][1]);
    const mMesPrevRev = num(marginMesRow.rows[0][2]);
    const mMesPrevCost = num(marginMesRow.rows[0][3]);
    const mMesLYRev = num(marginMesRow.rows[0][4]);
    const mMesLYCost = num(marginMesRow.rows[0][5]);
    const mMesCurr = marginFrac(mMesCurrRev, mMesCurrCost);
    const mMesPrev = marginFrac(mMesPrevRev, mMesPrevCost);
    const mMesLY = marginFrac(mMesLYRev, mMesLYCost);

    // Año margin YTD
    const mAnyoCurrRev = num(marginAnyoRow.rows[0][0]);
    const mAnyoCurrCost = num(marginAnyoRow.rows[0][1]);
    const mAnyoLYRev = num(marginAnyoRow.rows[0][2]);
    const mAnyoLYCost = num(marginAnyoRow.rows[0][3]);
    const mAnyoCurr = marginFrac(mAnyoCurrRev, mAnyoCurrCost);
    const mAnyoLY = marginFrac(mAnyoLYRev, mAnyoLYCost);

    // Spark: compute margin fraction per bucket; null buckets (no revenue) collapse to 0
    const mHoySpark = marginHoySpark7Row.rows.map((r) => marginFrac(num(r[1]), num(r[2])) ?? 0);
    const mHoySparkLabels = marginHoySpark7Row.rows.map((r) => {
      const [yy, mm2, dd2] = String(r[0]).split("-").map((s) => parseInt(s, 10));
      return DAYS_ES[new Date(yy, mm2 - 1, dd2).getDay()];
    });
    const mSemSpark = marginSemanaSpark6Row.rows.map((r) => marginFrac(num(r[2]), num(r[3])) ?? 0);
    const mSemSparkLabels = marginSemanaSpark6Row.rows.map((r) => `s${num(r[1])}`);
    const mMesSpark = marginMesSpark5Row.rows.map((r) => marginFrac(num(r[2]), num(r[3])) ?? 0);
    const mMesSparkLabels = marginMesSpark5Row.rows.map((r) => MONTHS_ES[num(r[1]) - 1] || "");
    const mAnyoSpark = marginAnyoSpark5Row.rows.map((r) => marginFrac(num(r[2]), num(r[3])) ?? 0);
    const mAnyoSparkLabels = marginAnyoSpark5Row.rows.map((r) => MONTHS_ES[num(r[1]) - 1] || "");

    const marginPeriods: HomeViewModel["marginPeriods"] = [
      {
        id: "hoy",
        label: "Hoy",
        value: mHoyCurr,
        deltaPrev: mHoyCurr !== null && mHoyPrev !== null ? mHoyCurr - mHoyPrev : 0,
        prevLabel: "vs ayer",
        deltaYoY: mHoyLYRev > 0 && mHoyCurr !== null ? mHoyCurr - (mHoyLY ?? 0) : null,
        yoyLabel: `vs ${dateLabelEs(lastYearSameDay)}`,
        spark: mHoySpark,
        sparkLabels: mHoySparkLabels,
      },
      {
        id: "semana",
        label: "Semana",
        value: mSemCurr,
        deltaPrev: mSemCurr !== null && mSemPrev !== null ? mSemCurr - mSemPrev : 0,
        prevLabel: "vs sem ant",
        deltaYoY: mSemLYRev > 0 && mSemCurr !== null ? mSemCurr - (mSemLY ?? 0) : null,
        yoyLabel: `vs sem ${isoWeekOf(asOfDateObj)} ${asOfDateObj.getFullYear() - 1}`,
        spark: mSemSpark,
        sparkLabels: mSemSparkLabels,
      },
      {
        id: "mes",
        label: "Mes",
        value: mMesCurr,
        deltaPrev: mMesCurr !== null && mMesPrev !== null ? mMesCurr - mMesPrev : 0,
        prevLabel: "vs mes ant",
        deltaYoY: mMesLYRev > 0 && mMesCurr !== null ? mMesCurr - (mMesLY ?? 0) : null,
        yoyLabel: `vs ${MONTHS_ES[asOfDateObj.getMonth()]} ${asOfDateObj.getFullYear() - 1}`,
        spark: mMesSpark,
        sparkLabels: mMesSparkLabels,
      },
      {
        id: "anyo",
        label: "Año (YTD)",
        value: mAnyoCurr,
        deltaPrev: mAnyoLYRev > 0 && mAnyoCurr !== null ? mAnyoCurr - (mAnyoLY ?? 0) : 0,
        prevLabel: `vs YTD ${asOfDateObj.getFullYear() - 1}`,
        deltaYoY: mAnyoLYRev > 0 && mAnyoCurr !== null ? mAnyoCurr - (mAnyoLY ?? 0) : null,
        yoyLabel: `vs ${asOfDateObj.getFullYear() - 1} mismo tramo`,
        spark: mAnyoSpark,
        sparkLabels: mAnyoSparkLabels,
      },
    ];

    // ─────────────────────────────────────────────────────────────────────
    // Daily trend
    // ─────────────────────────────────────────────────────────────────────
    const dailyTrend: HomeViewModel["dailyTrend"] = dailyTrendRow.rows.map((r) => {
      const dayNum = num(r[0]);
      const actualVal = num(r[1]);
      const lyVal = num(r[2]);
      const isFuture = r[3] === true || r[3] === "t";
      return {
        day: dayNum,
        actual: isFuture ? null : actualVal,
        ly: lyVal,
      };
    });

    // ─────────────────────────────────────────────────────────────────────
    // All stores
    // ─────────────────────────────────────────────────────────────────────
    const sparkByStore: Record<string, number[]> = {};
    for (const r of storesSparkRow.rows) {
      const code = String(r[0]);
      if (!sparkByStore[code]) sparkByStore[code] = [];
      sparkByStore[code].push(num(r[2]));
    }

    // Per-store margin map: tienda → margin fraction
    const marginByStore: Record<string, number> = {};
    for (const r of storesMarginRow.rows) {
      const code = String(r[0]);
      const rev = num(r[1]);
      const cost = num(r[2]);
      if (rev > 0) marginByStore[code] = (rev - cost) / rev;
    }

    const allStoreRows = storesRow.rows.map((r) => {
      const code = String(r[0]);
      const identificador = r[1];
      const poblacion = r[2];
      const sales = num(r[3]);
      const avg7 = num(r[4]);
      const total30d = num(r[5]);
      const lastSaleDate = r[6] ? String(r[6]) : null;
      const salesLY = r[7] !== null && r[7] !== undefined ? num(r[7]) : null;
      const returnsRate =
        r[8] !== null && r[8] !== undefined ? num(r[8]) : null;
      const tickets = r[9] !== null && r[9] !== undefined ? num(r[9]) : 0;
      const ticketMedio = tickets > 0 ? sales / tickets : 0;
      const delta = avg7 > 0 ? sales / avg7 - 1 : 0;
      const streakWeeks = storeStreakMap[code] ?? 0;
      const deltaYoY = salesLY !== null && salesLY > 0 ? sales / salesLY - 1 : null;
      return {
        code,
        name: storeName(identificador, poblacion, code),
        sales,
        delta,
        deltaYoY,
        spark: sparkByStore[code] ?? [],
        status: statusFromDeltas(delta, deltaYoY, streakWeeks),
        streakWeeks,
        total30d,
        lastSaleDate,
        margin: marginByStore[code] ?? null,
        returnsRate,
        tickets,
        ticketMedio,
      };
    });

    // Split: active = at least one sale in the last 30 days; inactive =
    // none. The main table only renders active stores so a couple of
    // closed-decade-ago tiendas don't bury today's active list. The
    // inactive list is exposed through "Ver tiendas inactivas" in the UI.
    const activeRaw = allStoreRows.filter((s) => s.total30d > 0);
    const inactiveRaw = allStoreRows.filter((s) => s.total30d <= 0);

    const topStores: HomeViewModel["topStores"] = activeRaw.map(
      ({ total30d: _t, lastSaleDate: _l, ...rest }) => rest as HomeViewModel["topStores"][number],
    );

    const inactiveStores: HomeViewModel["inactiveStores"] = inactiveRaw.map(
      ({ code, name, lastSaleDate }) => ({ code, name, lastSaleDate }),
    );

    // ─────────────────────────────────────────────────────────────────────
    // Retail ops
    // ─────────────────────────────────────────────────────────────────────
    const tickets = num(opsRetailRow.rows[0][0]);
    const gross = num(opsRetailRow.rows[0][1]);
    const devolu = num(opsRetailRow.rows[0][2]);
    const ticketMedio = tickets > 0 ? gross / tickets : 0;
    const monthRev = num(retailMonthRow.rows[0][0]);
    const monthCost = num(retailMonthRow.rows[0][1]);
    const margenPct = monthRev > 0 ? (monthRev - monthCost) / monthRev : 0;

    // Previous-day comparisons
    const ticketsPrev = num(opsRetailPrevDayRow.rows[0][0]);
    const grossPrev = num(opsRetailPrevDayRow.rows[0][1]);
    const devoluPrev = num(opsRetailPrevDayRow.rows[0][2]);
    const ticketMedioPrev = ticketsPrev > 0 ? grossPrev / ticketsPrev : 0;

    // Previous-month margin
    const prevMonthRev = num(retailPrevMonthRow.rows[0][0]);
    const prevMonthCost = num(retailPrevMonthRow.rows[0][1]);
    const prevMargenPct = prevMonthRev > 0 ? (prevMonthRev - prevMonthCost) / prevMonthRev : 0;

    // Return rate: today's rate and 30-day rolling baseline (both as fractions)
    const todayRate = gross > 0 ? devolu / gross : 0;
    const prevDayRate = grossPrev > 0 ? devoluPrev / grossPrev : 0;
    const baseline30dRaw = baseline30dRow.rows[0]?.[0];
    const baseline30d = baseline30dRaw != null ? num(baseline30dRaw) : null;
    const devoluSubEur = new Intl.NumberFormat("es-ES", {
      maximumFractionDigits: 0,
    }).format(devolu) + " €";

    const dayCompLabel = cutoffActive
      ? `vs ayer (hasta las ${String(cutoffHour).padStart(2, "0")}:00)`
      : "vs ayer";

    const opsRetail: Metric[] = [
      {
        id: "ticket",
        label: "Ticket medio",
        value: ticketMedio,
        format: "eur2",
        delta: ticketMedioPrev > 0 ? safeRatio(ticketMedio, ticketMedioPrev) : null,
        sub: dayCompLabel,
      },
      {
        id: "tickets",
        label: "Tickets",
        value: tickets,
        format: "int",
        delta: ticketsPrev > 0 ? safeRatio(tickets, ticketsPrev) : null,
        sub: dayCompLabel,
      },
      {
        id: "margen",
        label: "Margen mes",
        value: margenPct,
        format: "pct",
        delta: prevMonthRev > 0 ? margenPct - prevMargenPct : null,
        deltaUnit: "pp",
        sub: "vs mes ant",
      },
      {
        id: "tasa-devol",
        label: "Tasa devol.",
        value: todayRate,
        format: "pct",
        delta: prevDayRate > 0 ? safeRatio(todayRate, prevDayRate) : null,
        inverted: true,
        sub: devoluSubEur,
        baseline: baseline30d !== null ? { value: baseline30d, label: "media 30d" } : undefined,
      },
    ];

    // ─────────────────────────────────────────────────────────────────────
    // Health
    // ─────────────────────────────────────────────────────────────────────
    const lastWatermark = lastWatermarkRow.rows[0][0] as string | null;
    const lastWatermarkDate = lastWatermark ? new Date(lastWatermark) : null;
    const syncAgeSec = lastWatermarkDate
      ? (Date.now() - lastWatermarkDate.getTime()) / 1000
      : Number.NaN;

    const lastEtlStatus = etlRunRow.rows.length > 0
      ? String(etlRunRow.rows[0][1])
      : "—";
    const lastEtlStarted = etlRunRow.rows.length > 0
      ? new Date(String(etlRunRow.rows[0][2]))
      : null;
    const lastEtlTimeFmt = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const lastEtlLabel = lastEtlStarted
      ? `${lastEtlTimeFmt.format(lastEtlStarted)} · ${lastEtlStatus}`
      : "—";
    const totalRows = etlRunRow.rows.length > 0 ? num(etlRunRow.rows[0][4]) : 0;

    const health: HomeViewModel["health"] = {
      syncAge: fmtSyncAge(syncAgeSec),
      lastEtl: lastEtlLabel,
      anomalies: num(anomaliesRow.rows[0][0]),
      rows: totalRows,
    };

    const payload: HomeViewModel = {
      asOf: asOfHeader,
      asOfDate,
      maxAvailableDate,
      hero,
      periods,
      marginPeriods,
      dailyTrend,
      topStores,
      inactiveStores,
      networkReturnRate30d: baseline30d,
      opsRetail,
      health,
    };

    return NextResponse.json(payload);
  } catch (err) {
    // Return the standard ApiErrorResponse shape (code / timestamp / requestId /
    // sanitized details) so the home surfaces technical details + "Copiar como
    // JSON" exactly like widget errors do. The whole view model is built from
    // read-only queries, so DB_QUERY is the right code.
    const requestId = generateRequestId();
    console.error(`[api/home] failed to build view model (${requestId}):`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el inicio.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

/**
 * GET /api/ready — Readiness: PostgreSQL connectivity + connector-pipeline
 * freshness summary.
 *
 * Intended for orchestrators (Docker health with start_period, k8s
 * readiness). Returns 503 when Postgres is unreachable or checks exceed the
 * time budget. When connected, returns 200 with freshness derived from
 * `connector_run_results`/`connector_config` (see dashboard/lib/db/freshness.ts).
 *
 * Historical note (issue #241): the freshness portion used to read the
 * PowerShop-era `etl_watermarks` table the connector pipeline never writes,
 * so it always reported zero watermarks. It now reads the real connector
 * tables.
 */

import { NextResponse } from "next/server";
import { query, ConnectionError } from "@/lib/db";
import { getConnectorFreshness, UNDEFINED_TABLE } from "@/lib/db/freshness";

// Evaluate per-request — this route queries Postgres, so it must never be
// statically prerendered at build time (issue #241 / build-prerender fix).
export const dynamic = "force-dynamic";

function readyBudgetMs(): number {
  const raw = process.env.READY_CHECK_BUDGET_MS;
  if (raw === undefined || raw === "") return 2800;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2800;
}

class ReadyTimeoutError extends Error {
  constructor() {
    super("ready check exceeded time budget");
    this.name = "ReadyTimeoutError";
  }
}

function withTimeBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ReadyTimeoutError()), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function runReadyChecks(): Promise<{
  connectors: number;
  overallStale: boolean;
  // Issue #586 — propagated so GET can surface a distinct "unknown" status
  // instead of silently reading "ready" (fail-dark, never fail-green: see
  // dashboard/lib/db/freshness.ts's module docstring and D-125).
  overallUnknown: boolean;
  stalestConnector: string | null;
  freshestSuccessAt: string | null;
  note?: string;
}> {
  // Connectivity probe via the read pool so a down DB surfaces as
  // ConnectionError → 503 below.
  await query("SELECT 1");

  try {
    const health = await getConnectorFreshness();
    return {
      connectors: health.connectors.length,
      overallStale: health.overallStale,
      overallUnknown: health.overallUnknown,
      stalestConnector: health.stalestConnector?.connector ?? null,
      freshestSuccessAt: health.freshestSuccessAt,
    };
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === UNDEFINED_TABLE) {
      // Schema not applied yet — connected, but nothing to report. This is
      // its own explicit `note`, so it does NOT fall into overallUnknown
      // below (that path is for a reachable, applied schema with nothing
      // in scope, a different condition from "not applied at all").
      return {
        connectors: 0,
        overallStale: false,
        overallUnknown: false,
        stalestConnector: null,
        freshestSuccessAt: null,
        note: "connector tables missing",
      };
    }
    throw err;
  }
}

export async function GET(): Promise<NextResponse> {
  const budgetMs = readyBudgetMs();

  try {
    const summary = await withTimeBudget(runReadyChecks(), budgetMs);
    // Issue #586 — readiness still gates ONLY on DB reachability (503 below
    // is the only non-200 path here); this three-way status is informational.
    // `overallUnknown` must never read as "ready" any more than the TopBar
    // dot may read it as green — same fail-dark rule, same source
    // (`getConnectorFreshness()`), see D-125.
    const status =
      summary.overallUnknown && !summary.note
        ? ("unknown" as const)
        : summary.overallStale && !summary.note
          ? ("degraded" as const)
          : ("ready" as const);

    return NextResponse.json({
      status,
      postgres: "ok",
      connectors: summary.connectors,
      overall_stale: summary.overallStale,
      overall_unknown: summary.overallUnknown,
      stalest_connector: summary.stalestConnector,
      freshest_success_at: summary.freshestSuccessAt,
      ...(summary.note ? { note: summary.note } : {}),
    });
  } catch (err) {
    if (err instanceof ConnectionError) {
      return NextResponse.json(
        { status: "not_ready", postgres: "error", detail: String(err.message) },
        { status: 503 },
      );
    }
    if (err instanceof ReadyTimeoutError) {
      return NextResponse.json(
        {
          status: "not_ready",
          postgres: "unknown",
          detail: "Readiness checks exceeded time budget",
        },
        { status: 503 },
      );
    }
    console.error("[ready] Unexpected error:", err);
    return NextResponse.json(
      { status: "not_ready", postgres: "error" },
      { status: 503 },
    );
  }
}

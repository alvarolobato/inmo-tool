/**
 * GET /api/ready — Readiness: PostgreSQL connectivity + ETL data freshness summary.
 *
 * Intended for orchestrators (Docker health with start_period, k8s readiness).
 * Returns 503 when Postgres is unreachable or checks exceed the time budget.
 * When connected, returns 200 with freshness derived from `etl_watermarks`.
 */

import { NextResponse } from "next/server";
import { query, ConnectionError } from "@/lib/db";

const STALE_THRESHOLD_HOURS = 36;

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
  watermarks: number;
  overallStale: boolean;
  stalestTable: string | null;
  note?: string;
}> {
  await query("SELECT 1");

  try {
    const wm = await query(
      "SELECT table_name, last_sync_at FROM etl_watermarks ORDER BY last_sync_at ASC",
    );

    if (wm.rows.length === 0) {
      return {
        watermarks: 0,
        overallStale: false,
        stalestTable: null,
      };
    }

    const now = new Date();
    const thresholdMs = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;
    let overallStale = false;
    let stalest: { name: string; last_sync: string } | null = null;

    for (const row of wm.rows) {
      const name = String(row[0]);
      const lastSyncRaw = row[1];
      const lastSync =
        lastSyncRaw instanceof Date
          ? lastSyncRaw.toISOString()
          : String(lastSyncRaw);
      const lastSyncDate = new Date(lastSync);
      const isStale = now.getTime() - lastSyncDate.getTime() > thresholdMs;
      if (isStale) overallStale = true;
      if (!stalest) stalest = { name, last_sync: lastSync };
    }

    return {
      watermarks: wm.rows.length,
      overallStale,
      stalestTable: stalest?.name ?? null,
    };
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "42P01") {
      return {
        watermarks: 0,
        overallStale: false,
        stalestTable: null,
        note: "etl_watermarks missing",
      };
    }
    throw err;
  }
}

export async function GET(): Promise<NextResponse> {
  const budgetMs = readyBudgetMs();

  try {
    const summary = await withTimeBudget(runReadyChecks(), budgetMs);
    const status =
      summary.overallStale && !summary.note
        ? ("degraded" as const)
        : ("ready" as const);

    return NextResponse.json({
      status,
      postgres: "ok",
      watermarks: summary.watermarks,
      overall_stale: summary.overallStale,
      stalest_table: summary.stalestTable,
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

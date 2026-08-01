import { query } from "@/lib/db";
import { findQueryOrigin, savedDashboardCandidates } from "@/lib/admin-query-origin";

export const SLOW_QUERIES_SQL = `
  SELECT
    LEFT(query, 500) AS query,
    calls,
    mean_exec_time AS mean_exec_time_ms,
    max_exec_time AS max_exec_time_ms,
    total_exec_time AS total_exec_time_ms,
    rows,
    ROUND(
      shared_blks_hit::numeric / NULLIF(shared_blks_hit + shared_blks_read, 0) * 100,
      1
    ) AS cache_hit_ratio
  FROM pg_stat_statements
  WHERE query LIKE '%ps_%'
  ORDER BY mean_exec_time DESC
  LIMIT 20
`;

export interface QueryOrigin {
  source: string;
  locationHint?: string;
}

export interface SlowQuery {
  query: string;
  calls: number;
  mean_exec_time_ms: number;
  max_exec_time_ms: number;
  total_exec_time_ms: number;
  rows: number;
  cache_hit_ratio: number | null;
  /** Best-effort origin guess from codebase fingerprinting. */
  origin?: QueryOrigin;
}

export interface SlowQueriesResponse {
  queries: SlowQuery[];
  error?: string;
}

/** Shared implementation for GET /api/admin/slow-queries and the admin HTML page. */
export async function fetchSlowQueries(): Promise<SlowQueriesResponse> {
  try {
    const result = await query(SLOW_QUERIES_SQL);

    // Build saved-dashboard candidates once per request (not per row) to keep
    // origin matching O(candidates + rows) rather than O(candidates × rows).
    // Non-fatal: origin matching still works from templates + review queries if
    // the dashboards table is unavailable.
    let dbCandidates: ReturnType<typeof savedDashboardCandidates> = [];
    try {
      const dbResult = await query(
        `SELECT id, spec->>'title' AS title, spec FROM dashboards LIMIT 50`,
      );
      const dashboards = dbResult.rows.map((row) => ({
        id: String(row[0]),
        title: row[1] ? String(row[1]) : undefined,
        spec: row[2] as unknown,
      }));
      dbCandidates = savedDashboardCandidates(dashboards);
    } catch {
      // dashboards table may not exist or spec column structure may differ
    }

    const queries: SlowQuery[] = result.rows.map((row) => {
      const rawQuery = String(row[0]);
      const origin =
        findQueryOrigin(rawQuery, { savedDashboardCandidateList: dbCandidates }) ?? undefined;
      return {
        query: rawQuery,
        calls: Number(row[1]),
        mean_exec_time_ms: Number(row[2]),
        max_exec_time_ms: Number(row[3]),
        total_exec_time_ms: Number(row[4]),
        rows: Number(row[5]),
        cache_hit_ratio: row[6] != null ? Number(row[6]) : null,
        ...(origin ? { origin } : {}),
      };
    });

    return { queries };
  } catch (err) {
    const pgErr = err as { code?: string };

    if (pgErr.code === "42P01") {
      return {
        queries: [],
        error: "pg_stat_statements not enabled",
      };
    }

    if (pgErr.code === "55000") {
      return {
        queries: [],
        error:
          "pg_stat_statements no está cargado en PostgreSQL (shared_preload_libraries). " +
          "Reinicia Postgres con la opción de arranque del compose (p. ej. docker-compose.yml: " +
          "shared_preload_libraries=pg_stat_statements) y crea la extensión si aplica.",
      };
    }

    console.error("[slow-queries] Unexpected error:", err);
    return { queries: [], error: "Internal server error" };
  }
}

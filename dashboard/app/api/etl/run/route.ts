/**
 * POST /api/etl/run
 *
 * Requests a manual ETL sync by inserting a row into etl_manual_trigger.
 * Returns 409 if a non-stale sync is already running (started < 4h ago).
 * A run started more than 4 hours ago is treated as stale and does not block.
 * If a pending trigger already exists, returns it with already_queued: true
 * without inserting again. Races (two concurrent first inserts) use ON CONFLICT.
 *
 * Request body (optional JSON):
 *   {
 *     force_full?: boolean,  // reset ALL watermark-backed syncs before run
 *     tables?: string[]      // reset watermarks for this subset only
 *   }
 * When force_full=true, `tables` is ignored. Names in `tables` are validated
 * against SYNC_NAMES_WITH_WATERMARK (see etl/main.py) — any unknown name
 * returns 400.
 *
 * Response codes:
 *   202 { trigger_id: number }                                — trigger inserted
 *   202 { trigger_id: number, already_queued: true }          — pending trigger already existed
 *   202 { trigger_id: null,   already_queued: true }          — trigger consumed by ETL between INSERT conflict and fallback SELECT
 *   400 { error: "invalid_body", detail: string }             — body rejected (unknown table, bad type)
 *   409 { error: "already_running", run_id: number }          — sync already active
 *   503 { error: "db_error" }                                 — database unreachable
 */

import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { sql } from "@/lib/db-write";
import { SYNC_NAMES_WITH_WATERMARK } from "@/lib/etl-sync-names";

const STALE_RUN_HOURS = 4;

const ALLOWED_FORCE_TABLES: ReadonlySet<string> = new Set(SYNC_NAMES_WITH_WATERMARK);

interface TriggerBody {
  forceFull: boolean;
  tables: string[];
}

interface BodyParseSuccess {
  ok: true;
  value: TriggerBody;
}

interface BodyParseFailure {
  ok: false;
  detail: string;
}

type BodyParseResult = BodyParseSuccess | BodyParseFailure;

async function parseBody(request: Request): Promise<BodyParseResult> {
  // No body at all (or whitespace-only body) is allowed and means
  // "default incremental run". Trim before checking so clients that send
  // a trailing newline are not rejected with a misleading JSON parse error.
  const raw = await request.text().catch(() => "");
  if (!raw.trim()) return { ok: true, value: { forceFull: false, tables: [] } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: "Body must be valid JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: "Body must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  let forceFull = false;
  if (obj.force_full !== undefined) {
    if (typeof obj.force_full !== "boolean") {
      return { ok: false, detail: "force_full must be a boolean" };
    }
    forceFull = obj.force_full;
  }

  let tables: string[] = [];
  if (obj.tables !== undefined) {
    if (!Array.isArray(obj.tables)) {
      return { ok: false, detail: "tables must be an array of strings" };
    }
    if (obj.tables.some((t) => typeof t !== "string")) {
      return { ok: false, detail: "tables must be an array of strings" };
    }
    tables = (obj.tables as string[]).map((t) => t.trim()).filter(Boolean);
    // Deduplicate — otherwise the same name could occupy multiple array slots.
    tables = Array.from(new Set(tables));

    const unknown = tables.filter((t) => !ALLOWED_FORCE_TABLES.has(t));
    if (unknown.length > 0) {
      return {
        ok: false,
        detail: `Unknown table name(s): ${unknown.join(", ")}`,
      };
    }
  }

  // force_full short-circuits the whitelist — irrelevant which subset was sent.
  if (forceFull) tables = [];

  return { ok: true, value: { forceFull, tables } };
}

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = await parseBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.detail },
      { status: 400 },
    );
  }
  const { forceFull, tables } = parsed.value;

  try {
    const activeResult = await query(
      `SELECT id, started_at
       FROM etl_sync_runs
       WHERE status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`,
    );

    if (activeResult.rows.length > 0) {
      const [runId, startedAt] = activeResult.rows[0];
      const startedAtDate =
        startedAt instanceof Date ? startedAt : new Date(String(startedAt));
      const staleThreshold = new Date(
        Date.now() - STALE_RUN_HOURS * 60 * 60 * 1000,
      );

      if (startedAtDate >= staleThreshold) {
        return NextResponse.json(
          { error: "already_running", run_id: Number(runId) },
          { status: 409 },
        );
      }
    }

    const pendingResult = await query(
      `SELECT id FROM etl_manual_trigger WHERE status = 'pending' LIMIT 1`,
    );
    if (pendingResult.rows.length > 0) {
      const [pendingId] = pendingResult.rows[0];
      return NextResponse.json(
        { trigger_id: Number(pendingId), already_queued: true },
        { status: 202 },
      );
    }

    // The unique partial index on status='pending' prevents duplicate pending rows.
    // ON CONFLICT DO NOTHING + RETURNING may return no rows if one already exists;
    // fetch the existing row in that case so we always return a trigger_id.
    const triggeredBy =
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "dashboard";
    const rows = await sql<{ id: number }>(
      `INSERT INTO etl_manual_trigger (status, force_full, force_tables, triggered_by)
       VALUES ('pending', $1, $2, $3)
       ON CONFLICT (status) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [forceFull, tables, triggeredBy],
    );

    let triggerId: number;
    if (rows.length > 0) {
      triggerId = Number(rows[0].id);
    } else {
      const existing = await query(
        `SELECT id FROM etl_manual_trigger WHERE status = 'pending' LIMIT 1`,
      );
      if (existing.rows.length > 0) {
        triggerId = Number(existing.rows[0][0]);
      } else {
        // The trigger was consumed between our INSERT conflict and this SELECT.
        // Treat it as already queued (the ETL already picked it up).
        return NextResponse.json(
          { trigger_id: null, already_queued: true },
          { status: 202 },
        );
      }
    }
    return NextResponse.json({ trigger_id: triggerId }, { status: 202 });
  } catch (err) {
    console.error("[etl/run] trigger failed:", err);
    return NextResponse.json({ error: "db_error" }, { status: 503 });
  }
}

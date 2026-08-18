/**
 * Persistence for subscription quota readings (D-106).
 *
 * Server-only: imports `lib/db-write`.
 */

import { sql } from "@/lib/db-write";
import type { QuotaSnapshot } from "@/lib/llm-quota";

interface Row {
  read_at: string;
  session_pct: number | null;
  week_pct: number | null;
  week_top_model_pct: number | null;
  session_resets_at: string | null;
  week_resets_at: string | null;
}

/** Persist one reading. Best-effort: telemetry must never fail the caller. */
export async function saveQuotaReading(
  s: QuotaSnapshot,
  source = "host-poller",
): Promise<void> {
  await sql(
    `INSERT INTO llm_quota_reading
       (read_at, session_pct, week_pct, week_top_model_pct,
        session_resets_at, week_resets_at, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      s.readAt,
      s.session?.pctUsed ?? null,
      s.week?.pctUsed ?? null,
      s.weekTopModel?.pctUsed ?? null,
      s.session?.resetsAt ?? null,
      s.week?.resetsAt ?? null,
      source,
    ],
  );
}

/**
 * Newest reading, or null when none has ever been recorded.
 *
 * Deliberately unfiltered by age: staleness is a decision for
 * `evaluateQuota`, which distinguishes "old reading" (allow, but say the cap
 * is not being enforced) from "no reading". Filtering here would collapse
 * those two into the same answer.
 */
export async function getLatestQuotaReading(): Promise<QuotaSnapshot | null> {
  const rows = await sql<Row>(
    `SELECT read_at, session_pct, week_pct, week_top_model_pct,
            session_resets_at, week_resets_at
       FROM llm_quota_reading
      ORDER BY read_at DESC, id DESC
      LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  const win = (pct: number | null, resets: string | null) =>
    pct === null ? null : { pctUsed: Number(pct), resetsAt: resets };
  return {
    session: win(r.session_pct, r.session_resets_at),
    week: win(r.week_pct, r.week_resets_at),
    weekTopModel: win(r.week_top_model_pct, null),
    readAt: new Date(r.read_at).toISOString(),
  };
}

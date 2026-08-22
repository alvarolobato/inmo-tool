/**
 * GET /api/etl/queues — the Estado board's "Colas" band (issue #640, #636).
 *
 * Depth + 24h in/out flow + oldest-item age for every backlog in the
 * pipeline, computed as plain aggregates over the queue tables themselves
 * (lib/db/queues.ts). Trend and severity are pure derivations in
 * lib/queues.ts.
 *
 * Always returns 200 — on any DB error it degrades to `ok: false` with an
 * empty list rather than a 500, so a transient query failure can't break the
 * admin landing page. `ok: false` must be read as UNKNOWN, never "nothing is
 * queued": same posture as /api/etl/source-health (issue #638 review).
 */

import { NextResponse } from "next/server";
import { getQueues } from "@/lib/db/queues";
import type { QueuesResponse } from "@/lib/queues";

export type { QueuesResponse };

// Always evaluate per-request — a statically-rendered fallback (Postgres
// unreachable at build time) would otherwise serve an empty payload forever.
export const dynamic = "force-dynamic";

const UNKNOWN_RESPONSE: QueuesResponse = {
  queues: [],
  generatedAt: new Date(0).toISOString(),
  ok: false,
};

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await getQueues());
  } catch (err) {
    console.error("[queues] error computing queue depths:", err);
    return NextResponse.json(UNKNOWN_RESPONSE);
  }
}

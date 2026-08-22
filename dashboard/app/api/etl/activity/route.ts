/**
 * GET /api/etl/activity — the unified ingest chronology (issue #644).
 *
 * Query params:
 *   `days`   1..14, default 3 — how many Madrid-local days to return.
 *   `before` `YYYY-MM-DD`     — return the `days` days ENDING on this day
 *                               (inclusive). Omitted = ending today.
 *
 * Paging is by whole days rather than by a row cursor, on purpose: capture
 * sessions and status-change runs are derived groupings, and a cursor
 * landing mid-session would either split one across two pages or re-emit it
 * truncated. See `lib/activity.ts`'s header.
 *
 * Always 200 on a read failure. It degrades to `{ days: [], ok: false }`
 * rather than a 500 — `days: []` is the shape of BOTH "nothing happened" and
 * "we could not find out", so `ok` is what separates them and the client
 * must read it before rendering "sin actividad" (same posture as
 * `/api/etl/source-health`, #638 review). A malformed parameter still 400s:
 * that is the caller's bug, not a degraded read.
 *
 * Admin-gated by middleware like every other `/api/etl/*` read.
 */

import { NextRequest, NextResponse } from "next/server";
import { getActivityEvents, getPreviousActivityDay } from "@/lib/db/activity";
import { madridDay, shiftDay } from "@/lib/activity";
import type { ActivityDay, ActivityResponse } from "@/lib/activity";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 3;
const MAX_DAYS = 14;

const DEGRADED: ActivityResponse = {
  days: [],
  fromDay: "",
  toDay: "",
  nextBefore: null,
  truncated: false,
  generatedAt: new Date(0).toISOString(),
  ok: false,
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  const rawDays = searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (rawDays !== null) {
    if (!/^\d+$/.test(rawDays)) {
      return NextResponse.json(
        { error: "El parámetro days debe ser un entero entre 1 y " + MAX_DAYS + "." },
        { status: 400 },
      );
    }
    days = Math.min(Math.max(parseInt(rawDays, 10), 1), MAX_DAYS);
  }

  const rawBefore = searchParams.get("before");
  if (rawBefore !== null && !DAY_RE.test(rawBefore)) {
    return NextResponse.json(
      { error: "El parámetro before debe tener el formato YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const toDay = rawBefore ?? madridDay(new Date());
  const fromDay = shiftDay(toDay, -(days - 1));
  const toDayExclusive = shiftDay(toDay, 1);

  try {
    const [{ events, truncated }, nextBefore] = await Promise.all([
      getActivityEvents({ fromDay, toDayExclusive }),
      getPreviousActivityDay(fromDay),
    ]);

    // Bucket into Madrid-local days, newest day first. The events already
    // arrive newest-first from the database, so pushing in order preserves
    // the merge order inside each day too.
    const byDay = new Map<string, ActivityDay>();
    for (const ev of events) {
      const day = madridDay(new Date(ev.t));
      let bucket = byDay.get(day);
      if (!bucket) {
        bucket = { day, events: [] };
        byDay.set(day, bucket);
      }
      bucket.events.push(ev);
    }

    const response: ActivityResponse = {
      days: [...byDay.values()],
      fromDay,
      toDay,
      nextBefore,
      truncated,
      generatedAt: new Date().toISOString(),
      ok: true,
    };
    return NextResponse.json(response);
  } catch (err) {
    console.error("[activity] error building the ingest chronology:", err);
    return NextResponse.json(DEGRADED);
  }
}

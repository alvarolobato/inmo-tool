/**
 * Auto-mode v2 planner API (issue #516).
 *
 * GET /api/etl/auto-plan[?portal=idealista][&force=1]
 *   → ONE next unit for the extension's auto driver:
 *       { kind: 'harvest', task: { profileId, taskId, portal, url } }
 *       { kind: 'drain',   urls: string[] }
 *       { kind: 'idle',    retryAfterSec: number }
 *
 * v1's auto mode only drained the ALREADY-KNOWN worklist (GET
 * /api/etl/worklist?pending=1) — a due connector with an empty pending set made
 * auto idle, so NEW listings were never discovered automatically. v2 drives the
 * full discovery → harvest → capture loop: the endpoint hands the extension the
 * most-DUE (profile × connector) search task to open+enumerate+seed+capture; only
 * when nothing is due does it fall back to draining leftover pending detail URLs,
 * and only when neither exists does it idle.
 *
 *   - `force=1` (the popup "Forzar" toggle): ignore staleness — every task is a
 *     harvest candidate (round-robin oldest-run first), and the drain fallback
 *     returns the full pending set (dueOnly=0) instead of the due-only subset.
 *   - `portal=` restricts both harvest and drain to a single portal.
 *
 * Admin-gated by middleware.ts (`/api/*` is gate-by-default; the extension sends
 * `x-admin-key`) — no separate auth surface here, same as the sibling
 * worklist route.
 */

import { NextRequest, NextResponse } from "next/server";
import { listPendingWorklist } from "@/lib/db/worklist";
import { getPortalDuePriority } from "@/lib/db/worklist-priority";
import { getHarvestCandidates } from "@/lib/db/auto-plan-candidates";
import { selectNextPendingUrls } from "@/lib/worklist";
import { planAutoUnit } from "@/lib/auto-plan";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// How many leftover pending detail URLs a single `drain` unit carries. Bounded
// like the worklist ?pending endpoint — a harvest fans out into a full batch, so
// the drain fallback stays a modest slice.
const DRAIN_LIMIT = 100;
// Advisory slow-poll delay the driver may use when idle. The extension also has
// its own alarm timeout; this is a hint so the server can widen the poll later
// without an extension redeploy.
const IDLE_RETRY_AFTER_SEC = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const portal = request.nextUrl.searchParams.get("portal")?.trim() || undefined;
  const forceParam = request.nextUrl.searchParams.get("force");
  const force = forceParam === "1" || forceParam === "true";

  try {
    // Harvest candidates (best-effort — never throws) and the leftover pending
    // detail URLs, ranked with the SAME due-first logic the worklist uses.
    const [candidates, pendingItems, duePriority] = await Promise.all([
      getHarvestCandidates(portal),
      listPendingWorklist(portal),
      getPortalDuePriority(),
    ]);
    // Drain respects staleness unless forcing (mirrors v1 dueOnly semantics).
    const drainUrls = selectNextPendingUrls(pendingItems, duePriority, DRAIN_LIMIT, !force);

    const unit = planAutoUnit(candidates, drainUrls, IDLE_RETRY_AFTER_SEC, force);
    return NextResponse.json(unit);
  } catch (err) {
    console.error(`[${requestId}] Error al planificar el siguiente paso de auto:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo planificar el siguiente paso de la captura automática.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

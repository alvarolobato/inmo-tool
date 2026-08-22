/**
 * Auto-mode v2 planner API (issue #516).
 *
 * GET /api/etl/auto-plan[?portal=idealista][&force=1]
 *   → ONE next unit for the extension's auto driver:
 *       { kind: 'spike',   items: [{ id, url }] }
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
 *   - `spikeOrigins=` (comma-separated `scheme://host`): the origins the
 *     extension reports it already holds a Chrome host permission for. ONLY
 *     spike rows on one of those origins are delivered — and delivering one
 *     charges it an attempt, right here, in the same statement (issue #705
 *     review F1/F2/F5). The queue therefore advances on a server-side fact
 *     rather than on the driver choosing to report back, and a row nobody can
 *     open yet is never charged for the operator's slowness.
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
import { claimSpikeRequestsForDelivery } from "@/lib/db/spike-queue";
import { SPIKE_UNIT_LIMIT, spikePermissionOrigin } from "@/lib/spike-queue";
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
// A sanity bound on the origin list the extension sends: the pending queue is
// capped at MAX_PENDING_SPIKE_REQUESTS and one candidate site is a handful of
// pages, so a couple of dozen distinct origins is already generous. Anything
// past this is a malformed caller, not a real permission set.
const MAX_SPIKE_ORIGINS = 50;

/**
 * The origins the driver says it can open, normalised the same way the stored
 * `origin` column is (`scheme://hostname`, port dropped — a Chrome match
 * pattern has none). Anything unparseable is silently dropped: an origin we
 * can't normalise can't match a row either.
 */
function parseSpikeOrigins(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const origin = spikePermissionOrigin(part.trim());
    if (origin && !out.includes(origin)) out.push(origin);
    if (out.length >= MAX_SPIKE_ORIGINS) break;
  }
  return out;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const portal = request.nextUrl.searchParams.get("portal")?.trim() || undefined;
  const forceParam = request.nextUrl.searchParams.get("force");
  const force = forceParam === "1" || forceParam === "true";
  const spikeOrigins = parseSpikeOrigins(request.nextUrl.searchParams.get("spikeOrigins"));

  try {
    // Harvest candidates (best-effort — never throws) and the leftover pending
    // detail URLs, ranked with the SAME due-first logic the worklist uses.
    const [candidates, pendingItems, duePriority, spikeItems] = await Promise.all([
      getHarvestCandidates(portal),
      listPendingWorklist(portal),
      getPortalDuePriority(),
      // Prospective-site captures (issue #705). Deliberately UNSCOPED by
      // `portal`: a spike request has no portal by definition (that is what
      // makes it a spike), so a portal-restricted Auto session would otherwise
      // never drain the queue at all. Bounded by SPIKE_UNIT_LIMIT — it
      // preempts harvest/drain, so it must stay a couple of pages, not a pass.
      //
      // This CLAIMS the rows (charges each one an attempt) rather than merely
      // listing them: see claimSpikeRequestsForDelivery. Handing a row out is
      // the server-side fact the queue advances on, so no amount of client
      // silence can leave the unit replanning the same five rows forever.
      claimSpikeRequestsForDelivery(SPIKE_UNIT_LIMIT, spikeOrigins),
    ]);
    // Drain respects staleness unless forcing (mirrors v1 dueOnly semantics).
    const drainUrls = selectNextPendingUrls(pendingItems, duePriority, DRAIN_LIMIT, !force);

    const unit = planAutoUnit(
      candidates,
      drainUrls,
      IDLE_RETRY_AFTER_SEC,
      force,
      spikeItems,
    );
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

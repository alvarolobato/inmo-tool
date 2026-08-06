/**
 * Capture task-run ledger API for the task-driven Captura page (issue #289).
 *
 * GET  /api/profiles/[id]/capture-task-runs
 *      → { profileId, runs: { [taskId]: ISO }, staleness: { defaultDays, byPortal },
 *          activity: PortalCaptureActivity[] }
 *      The page joins `runs` to the profile's `tasks[]` (from
 *      /api/profiles/[id]/search-urls) to compute each task's grey/due state,
 *      using `staleness` as the per-portal window. `activity` is the REAL
 *      per-portal capture activity from `extension_capture` (what actually
 *      landed, whether via a batch harvest or opening detail pages one by one)
 *      — so the headline progress is not empty when captures are happening but
 *      nothing seeded `capture_worklist`.
 *
 * POST /api/profiles/[id]/capture-task-runs   { taskId: string }
 *      → { ok: true, taskId, lastRunAt }
 *      Records (upserts) that the task was just run — the button POSTs this
 *      before opening the portal in a new tab. Re-running just bumps the
 *      timestamp (idempotent per press).
 *
 * Admin-gated by middleware.ts (`/api/*` is gate-by-default), same as every
 * other write-capable route — no separate auth surface here.
 *
 * Error codes: 400 invalid id / missing taskId · 404 profile not found ·
 * 500 unexpected.
 */

import { NextRequest, NextResponse } from "next/server";
import { getProfileById } from "@/lib/db/profiles";
import { getTaskRuns, recordTaskRun, getPortalCaptureActivity } from "@/lib/db/capture-task-run";
import { getStalenessConfig } from "@/lib/captura-staleness-config";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const profile = await getProfileById(id);
    if (!profile) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    const [runs, activity] = await Promise.all([getTaskRuns(id), getPortalCaptureActivity()]);
    return NextResponse.json({ profileId: id, runs, staleness: getStalenessConfig(), activity });
  } catch (error) {
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(error), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}

interface RecordBody {
  taskId?: unknown;
  // Issue #376: the real harvested result count for this run, when the caller
  // knows it (the zero-results regression monitor's extension-path signal).
  resultCount?: unknown;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let body: RecordBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
  if (!taskId) {
    return NextResponse.json(
      formatApiError("Falta el campo 'taskId'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const profile = await getProfileById(id);
    if (!profile) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    const resultCount =
      typeof body.resultCount === "number" && Number.isFinite(body.resultCount)
        ? body.resultCount
        : null;
    const lastRunAt = await recordTaskRun(id, taskId, resultCount);
    return NextResponse.json({ ok: true, taskId, lastRunAt });
  } catch (error) {
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(error), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}

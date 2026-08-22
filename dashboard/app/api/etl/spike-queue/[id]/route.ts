/**
 * PATCH/DELETE /api/etl/spike-queue/[id] — one prospective-site request
 * (issue #705).
 *
 * PATCH { status }          — operator sets skipped / re-queues to pending.
 * DELETE                    — drop the request.
 *
 * There is deliberately NO extension-facing "I tried and it didn't work"
 * verb here any more (issue #705 review F1/F5). Attempts are charged by the
 * statement that HANDS a row to the driver (GET /api/etl/auto-plan →
 * `claimSpikeRequestsForDelivery`), so the queue advances on a server-side
 * fact. A report the client can silently drop — or that a rotated admin key,
 * a 500 or a closed laptop can lose — was a second starvation path: with
 * `attempts` frozen at 0 the same five rows preempt every tick and the real
 * listing drain never resumes. At MAX_SPIKE_ATTEMPTS deliveries the row
 * becomes `unreachable`, never `failed`: the owner's browser failing to render
 * a candidate site's page is a finding ABOUT that site, which is the whole
 * point of a feasibility spike, not a pipeline fault for data-health.
 *
 * Admin-gated via the `/api/etl/:path*` matcher, like the list/add route.
 */

import { NextRequest, NextResponse } from "next/server";
import { deleteSpikeRequest, setSpikeStatus } from "@/lib/db/spike-queue";
import { SPIKE_STATUSES, type SpikeStatus } from "@/lib/spike-queue";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

interface PatchBody {
  status?: string;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id == null) {
    return NextResponse.json(
      formatApiError("Id de solicitud inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    if (!body.status || !SPIKE_STATUSES.includes(body.status as SpikeStatus)) {
      return NextResponse.json(
        formatApiError(
          `'status' debe ser uno de: ${SPIKE_STATUSES.join(", ")}.`,
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 400 },
      );
    }
    const updated = await setSpikeStatus(id, body.status as SpikeStatus);
    if (!updated) {
      return NextResponse.json(
        formatApiError("Solicitud no encontrada.", "VALIDATION", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[${requestId}] Error al actualizar la solicitud de evaluación:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo actualizar la solicitud. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id == null) {
    return NextResponse.json(
      formatApiError("Id de solicitud inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  try {
    const deleted = await deleteSpikeRequest(id);
    if (!deleted) {
      return NextResponse.json(
        formatApiError("Solicitud no encontrada.", "VALIDATION", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[${requestId}] Error al borrar la solicitud de evaluación:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo borrar la solicitud. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

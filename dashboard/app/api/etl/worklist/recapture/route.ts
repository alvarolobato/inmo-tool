/**
 * /api/etl/worklist/recapture — mark a cohort of listings for re-capture
 * (issue #677).
 *
 *   GET  ?portal=&predicate=&threshold=&onlyLiveCandidates=  → read-only preview
 *   POST { portal, predicate, threshold, onlyLiveCandidates,
 *          reason, expectedCount }                           → the bulk requeue
 *
 * Admin-gated via middleware's `/api/etl/:path*` matcher, same as the rest of
 * the worklist API — there is no auth in this handler by design.
 *
 * The split is the point: GET is what the "Calcular" button runs and it never
 * writes, so the operator always sees a count (and a time and storage cost)
 * before anything happens. POST re-resolves the cohort from the same predicate
 * and refuses when the count has moved — see requeueRecaptureCohort.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  previewRecaptureCohort,
  requeueRecaptureCohort,
} from "@/lib/db/recapture";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import {
  isRecapturePredicate,
  RECAPTURE_PREDICATE_LABEL,
  type RecaptureCohortRequest,
  type RecapturePredicate,
} from "@/lib/recapture";
import { isCapturePortal } from "@/lib/worklist";

/** Guards against a typo'd threshold turning into an enormous cohort. */
const MAX_THRESHOLD = 10_000;
const MAX_REASON_LENGTH = 500;

type Parsed =
  | { ok: true; request: RecaptureCohortRequest }
  | { ok: false; message: string };

/**
 * Validate a cohort request from either a query string or a JSON body. Every
 * field is checked against a closed set — the predicate vocabulary is an enum,
 * not free text, so no request can widen what the cohort query does.
 */
function parseCohort(raw: {
  portal?: unknown;
  predicate?: unknown;
  threshold?: unknown;
  onlyLiveCandidates?: unknown;
}): Parsed {
  const portal = typeof raw.portal === "string" ? raw.portal.trim() : "";
  if (!portal || !isCapturePortal(portal)) {
    return {
      ok: false,
      message: "'portal' debe ser un portal capturable por la extensión.",
    };
  }
  if (!isRecapturePredicate(raw.predicate)) {
    return { ok: false, message: "'predicate' no es un criterio conocido." };
  }
  const predicate: RecapturePredicate = raw.predicate;

  const spec = RECAPTURE_PREDICATE_LABEL[predicate];
  let threshold: number | null = null;
  if (spec.unit !== null) {
    const n =
      typeof raw.threshold === "number" ? raw.threshold : Number(raw.threshold);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_THRESHOLD) {
      return {
        ok: false,
        message: `'threshold' debe ser un entero entre 1 y ${MAX_THRESHOLD}.`,
      };
    }
    threshold = n;
  }

  // Default ON: re-capturing a listing nobody will look at is wasted browsing,
  // so the narrow cohort is what you get unless you ask for the wide one.
  const onlyLiveCandidates =
    raw.onlyLiveCandidates === false ||
    raw.onlyLiveCandidates === "false" ||
    raw.onlyLiveCandidates === "0"
      ? false
      : true;

  return {
    ok: true,
    request: { portal, predicate, threshold, onlyLiveCandidates },
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const q = request.nextUrl.searchParams;
  const parsed = parseCohort({
    portal: q.get("portal") ?? undefined,
    predicate: q.get("predicate") ?? undefined,
    threshold: q.get("threshold") ?? undefined,
    onlyLiveCandidates: q.get("onlyLiveCandidates") ?? undefined,
  });
  if (!parsed.ok) {
    return NextResponse.json(
      formatApiError(parsed.message, "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await previewRecaptureCohort(parsed.request));
  } catch (err) {
    console.error(`[${requestId}] recapture preview failed`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo calcular el conjunto de recaptura.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError(
        "Cuerpo de la petición inválido (se esperaba JSON).",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const parsed = parseCohort(body);
  if (!parsed.ok) {
    return NextResponse.json(
      formatApiError(parsed.message, "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  // The count the operator was shown and confirmed against. Required, not
  // optional: a bulk write with no agreed count is a bulk write nobody
  // approved the size of.
  const expectedCount = Number(body.expectedCount);
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    return NextResponse.json(
      formatApiError(
        "'expectedCount' es obligatorio: confirma primero el número de filas.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_LENGTH) : "";
  if (!reason) {
    return NextResponse.json(
      formatApiError(
        "'reason' es obligatorio: registra por qué se recaptura este conjunto.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const result = await requeueRecaptureCohort(
      parsed.request,
      reason,
      expectedCount,
    );
    if (result.requeued === 0 && result.expected !== expectedCount) {
      // Not an error the operator caused — the cohort simply moved. 409 so the
      // UI can say "vuelve a calcular" rather than showing a failure.
      return NextResponse.json(
        formatApiError(
          `El conjunto ha cambiado (ahora son ${result.expected} filas, no ${expectedCount}). Vuelve a calcular antes de confirmar.`,
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error(`[${requestId}] recapture requeue failed`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo marcar el conjunto para recaptura.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

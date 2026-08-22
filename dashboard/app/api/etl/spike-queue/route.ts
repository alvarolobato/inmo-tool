/**
 * Prospective-site capture queue API (issue #705) — "sitios en evaluación".
 *
 * GET  /api/etl/spike-queue
 *      → { rows, summaries, pendingOrigins, pendingCount }
 *      `pendingOrigins` is what the extension popup feeds
 *      `chrome.permissions.request()` and what the auto-driver echoes back on
 *      GET /api/etl/auto-plan as the subset it already holds; the rest backs
 *      the /admin/diagnostics panel. It covers `unreachable` rows as well as
 *      `pending` ones, so a batch that was given up on still offers its grant
 *      button instead of removing the only way to fix it (review F2).
 * POST /api/etl/spike-queue { urls: string[] | string, siteLabel, note? }
 *      → { added, duplicate, invalid, capped? }
 *
 * The sibling of POST /api/etl/worklist and its exact mirror image: that route
 * refuses any host WITHOUT a capture connector, this one refuses any host WITH
 * one. The two paste boxes are therefore mutually exclusive by host, which is
 * what makes "this is a new site I'm evaluating" an explicit choice rather than
 * silent acceptance of any URL (a mistyped idealista link is refused by both).
 *
 * Mounted under /api/etl so middleware.ts's `/api/etl/:path*` matcher already
 * admin-gates it — no new auth surface.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  addSpikeRequests,
  countPendingSpikeRequests,
  listSpikeRequests,
} from "@/lib/db/spike-queue";
import { grantableSpikeOrigins, summarizeSpikeRequests } from "@/lib/spike-queue";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Far below the worklist route's 5000: this queue is "a handful of pages from
// one candidate site", and every accepted URL eventually becomes a ~350 KB
// diagnostic row. See MAX_PENDING_SPIKE_REQUESTS for the standing cap.
const MAX_URLS_PER_REQUEST = 100;
const MAX_SITE_LABEL_LEN = 80;

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const rows = await listSpikeRequests();
    return NextResponse.json({
      rows,
      summaries: summarizeSpikeRequests(rows),
      pendingOrigins: grantableSpikeOrigins(rows),
      pendingCount: await countPendingSpikeRequests(),
    });
  } catch (err) {
    console.error(`[${requestId}] Error al cargar la cola de sitios en evaluación:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar la cola de sitios en evaluación.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

interface AddBody {
  urls?: string[] | string;
  siteLabel?: string;
  note?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  let body: AddBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let urls: string[];
  if (Array.isArray(body.urls)) {
    urls = body.urls.filter((u): u is string => typeof u === "string");
  } else if (typeof body.urls === "string") {
    urls = body.urls.split(/\s+/);
  } else {
    return NextResponse.json(
      formatApiError("Falta el campo 'urls' (array o texto).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  urls = urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    return NextResponse.json(
      formatApiError("No se ha proporcionado ninguna URL.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return NextResponse.json(
      formatApiError(
        `Demasiadas URLs en una sola petición (máx. ${MAX_URLS_PER_REQUEST}).`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  // Naming the candidate site is REQUIRED — the second deliberate act (after
  // choosing this box over the worklist one) that keeps a stray paste from
  // quietly becoming a spike capture.
  const siteLabel = typeof body.siteLabel === "string" ? body.siteLabel.trim() : "";
  if (!siteLabel) {
    return NextResponse.json(
      formatApiError(
        "Falta 'siteLabel': nombra el sitio que estás evaluando.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }
  if (siteLabel.length > MAX_SITE_LABEL_LEN) {
    return NextResponse.json(
      formatApiError(
        `El nombre del sitio es demasiado largo (máx. ${MAX_SITE_LABEL_LEN}).`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    // The dashboard's OWN host, refused alongside the standing localhost /
    // private-range denylist (review F3). manifest.json pre-declares
    // `http://localhost/*` and Chrome match patterns ignore the port, so
    // `http://localhost:4000/admin/...` would already be granted without a
    // prompt — the driver would open this very admin UI with the operator's
    // `ps_admin` cookie and upload the rendered page as a "candidate site
    // sample". `x-forwarded-host` is included because that is what the host
    // reads as behind the prod reverse proxy.
    const selfHosts = [
      request.nextUrl.hostname,
      request.headers.get("host") ?? "",
      request.headers.get("x-forwarded-host") ?? "",
    ].filter(Boolean);
    const result = await addSpikeRequests(urls, siteLabel, body.note ?? null, selfHosts);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error(`[${requestId}] Error al encolar URLs de sitio en evaluación:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron encolar las URLs. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

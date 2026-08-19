/**
 * POST /api/extension/capture — Browser-extension listing capture (issue #75).
 *
 * Accepts {url, html} from browser-extension/ (a forked/adapted
 * property_web_scraper Chrome extension, see NOTICE.md there) and inserts
 * a pending `extension_capture` row. Returns immediately — this does NOT
 * parse the listing synchronously.
 *
 * Why async: the actual field-mapping logic (etl/connectors/idealista.py,
 * sharing etl/connectors/extraction.py's fallback-chain helper with the
 * Fotocasa/Milanuncios connectors) is Python, running in the separate ETL
 * container. There's no shared filesystem or RPC channel between this
 * Node process and that one, and issue #75 explicitly requires a future
 * automated Idealista connector (if one ever becomes viable) to share one
 * source of truth with this capture path rather than a second,
 * drifting TypeScript reimplementation. etl/capture.py's background poll
 * (started alongside the connector scheduler loop, etl/main.py) picks up
 * pending rows on a short interval and does the real parsing + the same
 * etl.orchestrator._upsert_canonical_listing() persistence an automated
 * connector fetch would use.
 *
 * The extension polls GET /api/extension/capture/[id] for the result.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db-write";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";

const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10MB — a full rendered page is a few hundred KB; generous headroom without accepting an unbounded payload.

// Only http(s) accepted — a `javascript:`/`data:` URL with a legitimate-
// looking hostname (e.g. `javascript://idealista.com/inmueble/1/%0aalert(1)`)
// would otherwise pass etl/capture.py's hostname allowlist unchanged, get
// stored verbatim as `listing.url`, and execute when rendered as an <a href>
// on the property detail page (Opus review, PR #87 — verified end-to-end).
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

/**
 * Replace U+0000 with U+FFFD before the row reaches Postgres.
 *
 * A `text` column cannot hold a NUL byte — the driver reports
 * `invalid byte sequence for encoding "UTF8": 0x00` and the whole INSERT
 * fails, so the endpoint 500s and the operator's capture is lost with a
 * message that says nothing about why. Found in production on the first real
 * Hipoges capture (issue #207): its rendered DOM carries a NUL. Nothing is
 * Hipoges-specific about it — any portal can serialise one, and this endpoint
 * had no guard at all, so this was a latent 500 for every source.
 *
 * U+FFFD (REPLACEMENT CHARACTER) rather than deletion because that is exactly
 * what the HTML spec already mandates: the tokenizer replaces a U+0000 in the
 * input stream with U+FFFD. So a browser rendering this page saw U+FFFD too —
 * substituting it keeps our stored copy faithful to what the DOM meant, and
 * keeps every downstream character offset stable, which deleting would not.
 */
export function stripNulBytes(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value;
}

interface CaptureBody {
  url?: string;
  html?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  // This endpoint is reachable by anything that can talk to the dashboard
  // (the browser extension, but also anyone else on the same network) and
  // writes directly into the ingestion pipeline — same admin-key gate as
  // every other write-capable API route (Opus review, PR #87).
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }
  let body: CaptureBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const { url, html } = body;
  if (!url || typeof url !== "string") {
    return NextResponse.json(
      formatApiError("Falta el campo 'url'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (!html || typeof html !== "string") {
    return NextResponse.json(
      formatApiError("Falta el campo 'html'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json(
      formatApiError("'url' no es una URL válida.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (!ALLOWED_URL_SCHEMES.has(parsedUrl.protocol)) {
    return NextResponse.json(
      formatApiError(
        "'url' debe usar http o https.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    return NextResponse.json(
      formatApiError("El HTML capturado supera el tamaño máximo permitido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    // Sanitise at the write boundary, after the size check (so the cap still
    // measures what the extension actually sent) and covering `url` too — a
    // NUL anywhere in the tuple fails the same INSERT.
    const rows = await sql<{ id: number }>(
      "INSERT INTO extension_capture (url, html) VALUES ($1, $2) RETURNING id",
      [stripNulBytes(url), stripNulBytes(html)],
    );
    return NextResponse.json({ success: true, capture_id: rows[0].id });
  } catch (err) {
    console.error(`[${requestId}] Error al encolar la captura de la extensión:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo encolar la captura. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

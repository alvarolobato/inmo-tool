/**
 * POST /api/extension/diagnostic — "forzar captura + diagnóstico" (issue #671).
 *
 * A DIAGNOSTIC channel, deliberately separate from POST /api/extension/capture
 * (issue #75): this route writes ONLY to `extension_diagnostic` — a table no
 * ingest path reads (see etl/schema/init.sql's table comment). It never
 * creates or updates a `listing`, never enqueues a `capture_worklist` entry,
 * never touches `last_seen_at`. Synchronous — unlike /capture, there is no
 * background parse job to poll: this just stores what the extension sent.
 *
 * Accepts {url, html, title?, diagnostic?, network?} from browser-extension/
 * (popup.js's "Forzar captura + diagnóstico" button, content-script.js's
 * CAPTURE_DIAGNOSTIC handler, and — when a network-capture session was armed
 * — background.js's buffered, already-redacted entries). `diagnostic` and
 * `network` are stored as opaque JSONB; this route does not interpret them.
 *
 * Admin-gated exactly like /api/extension/capture: gate-by-default in
 * middleware AND re-checked in-route (defense in depth).
 *
 * Error codes:
 *   400 — missing/invalid url or html, or an oversized payload
 *   401 — missing/invalid admin credentials
 *   500 — unexpected error persisting the diagnostic
 */

import { NextRequest, NextResponse } from "next/server";
import { stripNulBytes } from "@/lib/strip-nul-bytes";
import { insertDiagnostic } from "@/lib/db/extension-diagnostics";
import type { DiagnosticDetectionBlock, DiagnosticNetworkCapture } from "@/lib/db/extension-diagnostics";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

// A full rendered page is a few hundred KB (the issue itself quotes ~350KB
// including the diagnostic block) — generous headroom without accepting an
// unbounded payload. Same cap as /api/extension/capture.
const MAX_HTML_BYTES = 10 * 1024 * 1024;
// Network-capture entries are ALREADY size-capped in the browser
// (network-recorder.js MAX_BODY_BYTES per entry, MAX_ENTRIES total) — this
// is defense-in-depth against a malformed/oversized payload reaching Postgres.
const MAX_NETWORK_JSON_BYTES = 8 * 1024 * 1024;

// Same javascript:/data: URL guard as /api/extension/capture (Opus review,
// PR #87) — a diagnostic row's `url` can end up rendered as a link on an
// admin page just as easily as a capture's can.
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

interface DiagnosticBody {
  url?: string;
  html?: string;
  title?: string;
  diagnostic?: DiagnosticDetectionBlock | null;
  network?: DiagnosticNetworkCapture | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  let body: DiagnosticBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const { url, html, title, diagnostic, network } = body;
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
      formatApiError("'url' debe usar http o https.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    return NextResponse.json(
      formatApiError("El HTML capturado supera el tamaño máximo permitido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (network != null) {
    let networkJson: string;
    try {
      networkJson = JSON.stringify(network);
    } catch {
      return NextResponse.json(
        formatApiError("'network' no es serializable.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    if (Buffer.byteLength(networkJson, "utf8") > MAX_NETWORK_JSON_BYTES) {
      return NextResponse.json(
        formatApiError("La captura de red supera el tamaño máximo permitido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
  }

  try {
    // Sanitise at the write boundary (same NUL-byte guard /capture uses),
    // after the size check so the cap still measures what was actually sent.
    const id = await insertDiagnostic({
      url: stripNulBytes(url),
      html: stripNulBytes(html),
      title: typeof title === "string" ? stripNulBytes(title) : null,
      extensionVersion: diagnostic?.extensionVersion ?? null,
      detection: diagnostic ?? null,
      network: network ?? null,
    });
    return NextResponse.json({ success: true, id }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[${requestId}] Error al guardar el diagnóstico de la extensión:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo guardar el diagnóstico. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

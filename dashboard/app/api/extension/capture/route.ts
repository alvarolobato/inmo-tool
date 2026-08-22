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
import { stripNulBytes } from "@/lib/strip-nul-bytes";
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


interface CaptureBody {
  url?: string;
  html?: string;
  /**
   * How long the extension waited for this page to render before snapshotting
   * it (issue #700), in ms. OPTIONAL and frequently absent — the extension is
   * an independently-installed Chrome artifact that does not upgrade in
   * lockstep with the server, and its own manual/forced-capture path doesn't
   * wait for render at all. Absent, null, and non-finite all store NULL
   * ("not measured"), never 0.
   */
  renderWaitMs?: unknown;
  /**
   * Terminal outcome to record instead of queueing the page for parsing
   * (issue #701). The ONLY accepted value is "never_rendered": the extension
   * opened the page, waited out that portal's whole render budget, and the
   * page never rendered enough to capture.
   *
   * A closed single-value enum rather than a free-form `status`, deliberately.
   * This endpoint is reachable by anything holding the admin key, and letting
   * a caller name the stored status would let it write 'done' — fabricating a
   * successful ingestion — or 'pending' for a page it knows is junk. The wire
   * format names an OUTCOME; the route decides what that means in the table.
   */
  outcome?: unknown;
  /** Free-form context for the never_rendered case; folded into error_msg. */
  diagnostic?: unknown;
  portal?: unknown;
  role?: unknown;
}

/**
 * One short human-readable line explaining an abandoned render wait.
 *
 * Structured JSON was the alternative and is the wrong shape here: this lands
 * in `error_msg`, which is rendered next to other capture outcomes in a list,
 * and the whole value of the signal is that the owner can read what happened
 * without opening anything. Truncated hard — `error_msg` is free text and the
 * payload is caller-controlled.
 */
function describeNeverRendered(body: CaptureBody): string {
  const d = (body.diagnostic ?? {}) as Record<string, unknown>;
  const parts: string[] = ["La página no llegó a renderizarse dentro del presupuesto."];
  if (typeof body.role === "string" && body.role) parts.push(`tipo=${body.role}`);
  if (typeof d.reason === "string" && d.reason) parts.push(`motivo=${d.reason}`);
  if (typeof d.harvested === "number") parts.push(`anuncios=${d.harvested}`);
  if (typeof d.placeholders === "number") parts.push(`placeholders=${d.placeholders}`);
  if (typeof d.bodyTextLength === "number") parts.push(`texto=${d.bodyTextLength}`);
  return parts.join(" ").slice(0, 500);
}

/**
 * Coerce the extension's `renderWaitMs` to a storable integer, or null.
 *
 * Deliberately strict, because this value is attacker-controllable in exactly
 * the same way `url`/`html` are (the endpoint is reachable by anything holding
 * the admin key) and it lands in an INTEGER column: a non-number, a NaN, an
 * Infinity, or a value past int4 range would otherwise turn a capture that
 * parsed perfectly well into a 500 at the INSERT. A nonsense duration is
 * discarded rather than rejected — the CAPTURE is the payload that matters,
 * and losing a listing over a bad telemetry field would be a strictly worse
 * trade than losing the telemetry.
 */
const MAX_RENDER_WAIT_MS = 10 * 60 * 1000; // 10 min — far past MAX_WAIT_MS (20s); anything beyond is noise.

function coerceRenderWaitMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > MAX_RENDER_WAIT_MS) return null;
  return Math.round(v);
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
  const renderWaitMs = coerceRenderWaitMs(body.renderWaitMs);
  // Only the one value is honoured; anything else is ignored and the capture
  // takes the normal pending path (see CaptureBody.outcome).
  const neverRendered = body.outcome === "never_rendered";
  if (!url || typeof url !== "string") {
    return NextResponse.json(
      formatApiError("Falta el campo 'url'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  // A never-rendered page is allowed to carry no HTML — by definition it may
  // have produced almost none. Every other capture still must, since an empty
  // capture is nothing but a queue entry the parser will reject.
  if (!neverRendered && (!html || typeof html !== "string")) {
    return NextResponse.json(
      formatApiError("Falta el campo 'html'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (typeof html !== "string" && html !== undefined) {
    return NextResponse.json(
      formatApiError("'html' debe ser texto.", "VALIDATION", undefined, requestId),
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
  const htmlText = typeof html === "string" ? html : "";
  if (Buffer.byteLength(htmlText, "utf8") > MAX_HTML_BYTES) {
    return NextResponse.json(
      formatApiError("El HTML capturado supera el tamaño máximo permitido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    // Sanitise at the write boundary, after the size check (so the cap still
    // measures what the extension actually sent) and covering `url` too — a
    // NUL anywhere in the tuple fails the same INSERT.
    // A never-rendered page is TERMINAL on insert (issue #701): `processed_at`
    // set, status already final. It must never sit in `pending`, or
    // etl/capture.py's poll would pick it up and spend a parse on a page the
    // extension already established has no advert on it. The HTML is still
    // stored — retained shell HTML from two ordinary captures is what made
    // #701 diagnosable from stored data instead of by re-fetching a
    // capture-only portal, and the next redesign will need the same evidence.
    const rows = neverRendered
      ? await sql<{ id: number }>(
          `INSERT INTO extension_capture (url, html, render_wait_ms, status, error_msg, processed_at, fields_extracted)
           VALUES ($1, $2, $3, 'never_rendered', $4, NOW(), 0) RETURNING id`,
          [
            stripNulBytes(url),
            htmlText ? stripNulBytes(htmlText) : null,
            renderWaitMs,
            stripNulBytes(describeNeverRendered(body)),
          ],
        )
      : await sql<{ id: number }>(
          "INSERT INTO extension_capture (url, html, render_wait_ms) VALUES ($1, $2, $3) RETURNING id",
          [stripNulBytes(url), stripNulBytes(htmlText), renderWaitMs],
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

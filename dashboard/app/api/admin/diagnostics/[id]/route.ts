/**
 * GET/DELETE /api/admin/diagnostics/[id] — retrieval + pruning for the
 * "forzar captura + diagnóstico" admin surface (issue #671).
 *
 * GET has two shapes, selected by `?format=`:
 *
 *   - default — the raw captured HTML as a DOWNLOAD (Content-Disposition:
 *     attachment), never rendered inline in the dashboard's own origin. This
 *     HTML came from an arbitrary third-party page and may carry live
 *     <script> tags; downloading it (opened separately, outside this origin,
 *     with no ps_admin cookie) is what keeps a captured page from ever
 *     running with the admin session's credentials. It is served as
 *     application/octet-stream + X-Content-Type-Options: nosniff rather than
 *     text/html: Content-Disposition already forces the download, so this is
 *     defense in depth (no rendered-inline path exists today and no
 *     dangerouslySetInnerHTML exists anywhere under app/admin/) — but the one
 *     header that could ever make a browser choose to render it should not
 *     say "html". PR #675 review, S3.
 *
 *   - `?format=json` — the whole stored row EXCEPT `html`: the full
 *     `detection` block and the full `network` block, as JSON. Without this
 *     the list page's ~6 rendered fields were the only non-SQL view of a
 *     ~13-field payload, and `harvest.extractDetailUrlsCount` (the "0 of 17"
 *     number that is the entire point of the Hipoges case), `renderReady
 *     .reason` and `bodyTextLength` were reachable only by hand-written SQL
 *     — which issue #671 explicitly ruled out ("He should not need SQL").
 *     `html` stays out on purpose: it is the one field with its own safe
 *     delivery path above, and inlining a ~350 KB page into a JSON response
 *     the browser WILL render inline would undo that. PR #675 review, B3.
 *
 * Together these are the "documented one-command export" half of the issue's
 * retrieval requirement; /admin/diagnostics (the list page) is the "small
 * admin surface" half.
 *
 * DELETE removes one diagnostic outright — the "owner can find and delete
 * what he sent without SQL" exit criterion. No soft-delete: a diagnostic has
 * no downstream reference (nothing reads this table — see the schema
 * comment), so there's nothing else to keep it consistent with.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDiagnostic, deleteDiagnostic } from "@/lib/db/extension-diagnostics";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de diagnóstico inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  try {
    const diagnostic = await getDiagnostic(id);
    if (!diagnostic) {
      return NextResponse.json(
        formatApiError("Diagnóstico no encontrado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    if (request.nextUrl.searchParams.get("format") === "json") {
      // Everything the row holds except `html` — see this route's docstring.
      const { html: _html, ...withoutHtml } = diagnostic;
      return NextResponse.json(withoutHtml, {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return new NextResponse(diagnostic.html, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="diagnostic-${id}.html"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error(`[${requestId}] Error al leer el diagnóstico:`, err);
    return NextResponse.json(
      formatApiError("No se pudo leer el diagnóstico.", "DB_QUERY", sanitizeErrorMessage(err), requestId),
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de diagnóstico inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  try {
    const deleted = await deleteDiagnostic(id);
    if (!deleted) {
      return NextResponse.json(
        formatApiError("Diagnóstico no encontrado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[${requestId}] Error al borrar el diagnóstico:`, err);
    return NextResponse.json(
      formatApiError("No se pudo borrar el diagnóstico.", "DB_QUERY", sanitizeErrorMessage(err), requestId),
      { status: 500 },
    );
  }
}

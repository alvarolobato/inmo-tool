/**
 * GET /api/extension/capture/[id] — Poll a browser-extension capture's status.
 *
 * See ../route.ts for the async-queue design (etl/capture.py processes the
 * row in the ETL container, this route just reads current state).
 *
 * If a matching profile happens to already exist (profile_listing_state
 * with matched=true for this property), the response includes a real
 * property_url the extension can link to. A freshly captured listing
 * usually won't have one yet — materialization only runs when a profile
 * is created/updated (dashboard/lib/filtering/materialize.ts's own
 * docstring already documents this as a known gap, not something new
 * here), not automatically on new listing ingestion.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db-write";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";

interface CaptureRow {
  status: "pending" | "done" | "failed" | "listing" | "withdrawn";
  error_msg: string | null;
  property_id: number | string | null;
  fields_extracted: number | null;
  fields_available: number | null;
  title: string | null;
  price_display: string | null;
}

interface MatchedProfileRow {
  profile_id: number | string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  // Sequential integer IDs are otherwise enumerable, leaking capture
  // titles/prices to anyone who can reach the dashboard (Opus review, PR #87).
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }
  const { id } = await params;
  const captureId = Number(id);
  if (!Number.isInteger(captureId) || captureId <= 0) {
    return NextResponse.json(
      formatApiError("Id de captura inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const rows = await sql<CaptureRow>(
      "SELECT status, error_msg, property_id, fields_extracted, fields_available, "
        + "title, price_display FROM extension_capture WHERE id = $1",
      [captureId],
    );
    if (rows.length === 0) {
      return NextResponse.json(
        formatApiError("Captura no encontrada.", "VALIDATION", undefined, requestId),
        { status: 404 },
      );
    }
    const row = rows[0];

    if (row.status === "pending") {
      return NextResponse.json({ success: true, status: "pending" });
    }
    // Issue #292: the captured page was a SEARCH/results listing page, not a
    // detail page. A clean, informational outcome (its detail links were
    // harvested into the batch worklist) — NOT a failure. fields_extracted
    // carries the harvested detail-link count; title carries the summary.
    if (row.status === "listing") {
      return NextResponse.json({
        success: true,
        status: "listing",
        title: row.title,
        detail_links: row.fields_extracted,
      });
    }
    // Issue #690 / D-159: the captured page was the portal's own "este
    // anuncio ya no está publicado" notice. Like "listing", a clean and
    // informational outcome, NOT a failure — the capture worked and produced
    // the most valuable answer a capture-only portal can give, so the popup
    // must say "anuncio retirado", never show a red error. `error_msg`
    // carries the evidence citation that was written to
    // listing_status_event.evidence.
    if (row.status === "withdrawn") {
      return NextResponse.json({
        success: true,
        status: "withdrawn",
        title: row.title,
        evidence: row.error_msg,
      });
    }
    if (row.status === "failed") {
      return NextResponse.json({
        success: false,
        status: "failed",
        error: { message: row.error_msg ?? "La extracción falló." },
      });
    }

    let propertyUrl: string | null = null;
    if (row.property_id !== null) {
      const matches = await sql<MatchedProfileRow>(
        "SELECT profile_id FROM profile_listing_state "
          + "WHERE property_id = $1 AND matched = true LIMIT 1",
        [row.property_id],
      );
      if (matches.length > 0) {
        propertyUrl = `/profiles/${matches[0].profile_id}/properties/${row.property_id}`;
      }
    }

    return NextResponse.json({
      success: true,
      status: "done",
      title: row.title,
      price: row.price_display,
      fields_extracted: row.fields_extracted,
      fields_available: row.fields_available,
      property_url: propertyUrl,
    });
  } catch (err) {
    console.error(`[${requestId}] Error al consultar el estado de la captura:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo consultar el estado de la captura.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

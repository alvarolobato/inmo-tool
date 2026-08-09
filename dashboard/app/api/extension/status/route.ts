/**
 * GET /api/extension/status — is the browser extension installed + linked right
 * now? (issue #509).
 *
 * Drives the inline `<ExtensionCta/>` on every capture-dependent surface: when
 * `linked` is false (no heartbeat, or the last one is stale) the surface shows
 * the "instalar/vincular la extensión" CTA; when true it shows nothing. Presence
 * is server-mediated — see POST /api/extension/heartbeat.
 *
 * Admin-gated like the rest of /api/extension/* (gate-by-default in middleware +
 * in-route re-check). A missing heartbeat row reads as `linked:false` rather
 * than an error, so a fresh install with no ping yet correctly shows the CTA.
 *
 * Error codes:
 *   401 — missing/invalid admin credentials
 *   500 — unexpected error reading the heartbeat
 */

import { NextRequest, NextResponse } from "next/server";
import { getExtensionStatus } from "@/lib/db/extension-status";
import { readServedExtensionVersion } from "@/lib/extension-served-version";
import type { ExtensionStatusResponse } from "@/lib/extension-status";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Reads Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  try {
    // Heartbeat status (DB) + the version we currently serve (filesystem). The
    // served version lets the CTA prompt an update while linked (#527); reading
    // it never throws, so a missing version file just yields servedVersion:null.
    const [status, servedVersion] = await Promise.all([
      getExtensionStatus(),
      readServedExtensionVersion(),
    ]);
    const body: ExtensionStatusResponse = { ...status, servedVersion };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[${requestId}] No se pudo leer el estado de la extensión:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo leer el estado de la extensión.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

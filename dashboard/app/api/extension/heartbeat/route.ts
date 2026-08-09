/**
 * POST /api/extension/heartbeat — browser-extension presence ping (issue #509).
 *
 * The extension cannot inject into the dashboard origin (its manifest
 * host_permissions cover only the portal hosts), so presence is SERVER-MEDIATED:
 * the extension fire-and-forget POSTs here on worker spawn and on its periodic
 * watchdog tick (browser-extension/background.js), and every capture-dependent
 * surface reads GET /api/extension/status to decide whether to show the
 * "instalar/vincular la extensión" CTA.
 *
 * Admin-gated exactly like /api/extension/capture: gate-by-default in middleware
 * (`/api/extension/*` is not on the public allow-list) AND re-checked in-route
 * (defense in depth; matches the capture/key routes). The body optionally
 * carries the extension's manifest version.
 *
 * Error codes:
 *   401 — missing/invalid admin credentials
 *   500 — unexpected error persisting the heartbeat
 */

import { NextRequest, NextResponse } from "next/server";
import { recordExtensionHeartbeat } from "@/lib/db/extension-status";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Writes the single heartbeat row per request; never prerender.
export const dynamic = "force-dynamic";

interface HeartbeatBody {
  version?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  // The body is optional — a heartbeat with no JSON is still a valid ping.
  let version: string | null = null;
  try {
    const body = (await request.json().catch(() => null)) as HeartbeatBody | null;
    if (body && typeof body.version === "string" && body.version.trim() !== "") {
      version = body.version.trim().slice(0, 64);
    }
  } catch {
    // Ignore a malformed body — presence is what matters, not the payload.
  }

  try {
    await recordExtensionHeartbeat(version);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[${requestId}] No se pudo registrar el heartbeat de la extensión:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo registrar el heartbeat de la extensión.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
